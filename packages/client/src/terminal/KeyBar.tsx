/**
 * The phone key bar: the keys a software keyboard does not have (C1, docs/MOBILE-PLAN.md §4).
 *
 * **Owner-directed divergence from the shipped Swift app.** The shipped app is a Mac app; there
 * is no Swift phone UI, so nothing in this file has a parity reference and nothing in it can have
 * one. `chrome/form-factor.ts` says that once for the whole phone program; this is the terminal
 * layer's instance of it.
 *
 * ## Keys, not bytes
 *
 * Every key here is delivered as a synthesized `keydown` through `TerminalRenderer.dispatchKey`,
 * never as bytes on the PTY stream. That is the decision recorded in MOBILE-PLAN.md §7 ("Key bar
 * routing", 2026-09-03) and it is what makes a tapped key IDENTICAL to a physical one rather than
 * merely similar: application-cursor mode (DECCKM), the keypad mode (DECNKM), the kitty keyboard
 * protocol and bracketed paste are all decided downstream of the event, by the pane's
 * capture-phase interceptor and the engine's own WASM encoder, and none of them are re-implemented
 * here. Measured in `KeyBar.test.tsx` against the real engine: ArrowUp comes out `ESC [ A` in
 * normal mode and `ESC O A` under DECCKM without this file knowing either mode exists.
 *
 * ## Sticky modifiers reach the SOFTWARE keyboard's next key
 *
 * Ctrl and Alt latch, and the key they apply to is usually not one of ours - "Ctrl then C" means
 * tapping Ctrl here and then C on the phone's own keyboard. So while a modifier is armed the bar
 * intercepts the next `keydown` on the pane ROOT, cancels it, and re-raises it through
 * `dispatchKey` with the modifier applied.
 *
 * The pane root is the binding point, not the terminal host, and that is load-bearing. The pane's
 * kitty interceptor is a CAPTURE-phase listener on `[data-terminal-host]` (§TERM-030) and the
 * engine's own listener is on the host too; the root is the host's parent, so a capture listener
 * there runs before both, whatever order the effects mounted in. The re-raised event then travels
 * the full path from the textarea up - kitty first, engine second - exactly as a physical Ctrl+C
 * does.
 *
 * Two bounded limits, recorded rather than papered over:
 *
 *   - the app's own key dispatcher is a WINDOW capture listener (`chrome/keys.ts`
 *     `installKeyDispatcher`), so it is still above this one: a key that is a Kelpi binding is
 *     consumed there and the latch is not spent on it. That is the right way round - a latched
 *     Ctrl must not turn a bound chord into terminal input;
 *   - only the `keydown` is re-raised. The engine registers no `keyup` listener at all, so the
 *     legacy path cannot tell; an application that asked for kitty's report-event-types would see
 *     the release without the modifier.
 *
 * ## …and on Android the next key is not a `keydown` at all
 *
 * Measured on the owner's phone (device round 2, 2026-09-03, Android + Chrome + a Gboard-class
 * keyboard, bytes read at the PTY through `stty -icanon -echo min 1; cat -v`): Esc, Tab, the
 * arrows, Home, End, `-`, `/` and `|` all arrived byte-exact, and two things did not.
 *
 *   - **Ctrl then the soft keyboard's `c` arrived as a plain `c`**, and Alt then `x` as a plain
 *     `x`. A soft keyboard's letter is not a `keydown` carrying that letter: Chrome raises
 *     `keydown` with `keyCode` 229, `key` `'Unidentified'` and an EMPTY `code`, and the letter
 *     itself arrives afterwards as `beforeinput` with `inputType` `'insertText'` and `data` `'c'`
 *     (the engine inserts it from there, `input-handler.ts` `handleBeforeInput`). The latch above
 *     listens on `keydown`, so it saw nothing it could modify and the letter went through plain.
 *   - **The soft keyboard's Enter never arrived** (no `^M` at the PTY), while Backspace did
 *     (`^?`) and typed text did. The engine maps keys by `event.code` through `KEY_MAP`
 *     (`input-handler.ts:389`); Android delivers Enter either as a `keydown` with `key` `'Enter'`
 *     and an empty `code`, or as `beforeinput` with `inputType` `'insertLineBreak'`. The first
 *     falls off the mapped path and then off the vendor fallback below it, which rescues only a
 *     single-scalar PRINTABLE (`:391-411`); the second is ignored, because `handleBeforeInput`
 *     forwards `insertText` and nothing else. Backspace survives for the complementary reason:
 *     the ONLY route in the engine that can emit `0x7f` is `KEY_MAP['Backspace']`, and the
 *     printables-only fallback could never have produced it, so Chrome must be delivering the
 *     soft keyboard's Backspace with a real `code` - which it does, because the engine's textarea
 *     is always empty and Chrome sends a genuine key event for a delete on an empty field rather
 *     than an IME edit. C2's `enterkeyhint="send"` on the textarea did not change any of it.
 *
 * So the bar handles the same keystroke in whichever of its two halves carries it, under the
 * phone form factor only (this component only mounts there):
 *
 *   - a `keydown` with an EMPTY `code` whose `key` is one of {@link NAMED_KEYS_WITHOUT_CODE} is
 *     cancelled and re-raised with the matching `code`, so the engine can map it;
 *   - a `beforeinput` of `insertText` with single-character `data`, while a modifier is latched,
 *     is cancelled and re-raised as the `keydown` that letter would have been, with the latch on
 *     it and the `code` for that character (the engine needs a `code`, and it needs `key` too,
 *     because the encoder takes the ctrl byte from the utf8);
 *   - a `beforeinput` of {@link LINE_BREAK_INPUT_TYPES} becomes Enter the same way.
 *
 * A key that arrives with a real `code` - every physical keyboard, on the phone as much as on a
 * desktop - is untouched by all of it and keeps the path it has today. So is an unmodified
 * single-scalar key with no `code`: the engine's own vendor fallback already rescues that one,
 * which is why plain typing on the phone worked before any of this.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement, type RefObject } from 'react';

import { tokens } from '../chrome/tokens';
import type { TerminalKeyInit } from './renderer';

/**
 * The touch target, in CSS px. 44 is Apple's HIG minimum and the number the brief names; it is
 * applied to BOTH axes, so a key is never a 44x30 sliver that a thumb misses.
 */
export const KEY_BAR_KEY_SIZE_PX = 44;

/**
 * The bar's total height in CSS px: {@link KEY_BAR_KEY_SIZE_PX} of key plus the 1 px hairline
 * that separates it from the terminal.
 *
 * Exported because it is the number the terminal SHRINKS by. The bar is in-flow at the bottom of
 * the pane (MOBILE-PLAN.md §7, "Keyboard inset ownership"), so the host loses this many pixels
 * through the pane's existing ResizeObserver path and the PTY is told about it once, like any
 * other resize. C2 owns the software-keyboard inset and applies it to the same box; the two
 * compose without either knowing about the other.
 */
export const KEY_BAR_HEIGHT_PX = KEY_BAR_KEY_SIZE_PX + 1;

/** The stable hook the audit and the sibling lanes query the bar by. */
export const KEY_BAR_ATTR = 'data-terminal-key-bar';

/** …and the one each key carries, e.g. `[data-terminal-key="ctrl"]`. */
export const KEY_ATTR = 'data-terminal-key';

/** Copy for the Paste key while C4 has not landed. */
export const PASTE_PENDING_TITLE = 'Paste is not wired up yet (phone task C4)';

/** The two modifiers that latch. */
export type StickyModifier = 'ctrl' | 'alt';

/** Which modifiers are armed for the next key. */
export interface StickyModifiers {
    readonly ctrl: boolean;
    readonly alt: boolean;
}

const NO_STICKY: StickyModifiers = { ctrl: false, alt: false };

/**
 * One key on the bar.
 *
 * `init` is a `KeyboardEventInit` and not a byte string, for the reason in the header. `code` is
 * always present because the engine maps `KeyboardEvent.code` to a USB HID key: a named key with
 * no `code` never reaches the encoder at all.
 */
export interface KeyBarKey {
    readonly id: string;
    /** What is painted on the key. */
    readonly label: string;
    /** The accessible name, for the keys whose label is a glyph. */
    readonly name: string;
    readonly title: string;
    /** A key that SENDS something. Mutually exclusive with `modifier` and `action`. */
    readonly init?: TerminalKeyInit | undefined;
    /** A key that LATCHES. */
    readonly modifier?: StickyModifier | undefined;
    /** A key that does something to the bar or the pane rather than to the terminal. */
    readonly action?: 'paste' | 'hideKeyboard' | undefined;
    /** Render the label wider than a single glyph (Esc, Tab, Home, End, Paste, Hide). */
    readonly wide?: boolean | undefined;
}

/**
 * The bar's contents, in order (the brief's list).
 *
 * `|` carries `shiftKey: true` on `Backslash` because that IS the physical key: on a US layout
 * the bar character is Shift+Backslash, and synthesizing the modifier is what makes the tap the
 * same event the hardware raises. `-` and `/` are their own unshifted keys and carry no modifier.
 */
export const KEY_BAR_KEYS: readonly KeyBarKey[] = [
    { id: 'esc', label: 'Esc', name: 'Escape', title: 'Escape', init: { key: 'Escape', code: 'Escape' }, wide: true },
    { id: 'tab', label: 'Tab', name: 'Tab', title: 'Tab', init: { key: 'Tab', code: 'Tab' }, wide: true },
    { id: 'ctrl', label: 'Ctrl', name: 'Control', title: 'Control, applied to the next key', modifier: 'ctrl', wide: true },
    { id: 'alt', label: 'Alt', name: 'Alt', title: 'Alt, applied to the next key', modifier: 'alt', wide: true },
    { id: 'left', label: '←', name: 'Left arrow', title: 'Left arrow', init: { key: 'ArrowLeft', code: 'ArrowLeft' } },
    { id: 'down', label: '↓', name: 'Down arrow', title: 'Down arrow', init: { key: 'ArrowDown', code: 'ArrowDown' } },
    { id: 'up', label: '↑', name: 'Up arrow', title: 'Up arrow', init: { key: 'ArrowUp', code: 'ArrowUp' } },
    { id: 'right', label: '→', name: 'Right arrow', title: 'Right arrow', init: { key: 'ArrowRight', code: 'ArrowRight' } },
    { id: 'home', label: 'Home', name: 'Home', title: 'Home', init: { key: 'Home', code: 'Home' }, wide: true },
    { id: 'end', label: 'End', name: 'End', title: 'End', init: { key: 'End', code: 'End' }, wide: true },
    { id: 'minus', label: '-', name: 'Hyphen', title: 'Hyphen', init: { key: '-', code: 'Minus' } },
    { id: 'slash', label: '/', name: 'Slash', title: 'Slash', init: { key: '/', code: 'Slash' } },
    { id: 'pipe', label: '|', name: 'Pipe', title: 'Pipe', init: { key: '|', code: 'Backslash', shiftKey: true } },
    { id: 'paste', label: 'Paste', name: 'Paste', title: PASTE_PENDING_TITLE, action: 'paste', wide: true },
    {
        id: 'hide-keyboard',
        label: 'Hide',
        name: 'Hide keyboard',
        title: 'Hide the software keyboard; tap the terminal to bring it back',
        action: 'hideKeyboard',
        wide: true
    }
];

export interface KeyBarProps {
    readonly paneID: string;
    /**
     * Raise a key at the engine the way a physical one arrives. Returns false when there was
     * nowhere to send it (an engine that is gone or not yet open), which is how a tap on a dead
     * pane stays a no-op instead of a thrown error.
     */
    readonly sendKey: (init: TerminalKeyInit) => boolean;
    /**
     * Where the sticky-modifier interceptor binds: the pane ROOT, which is above the host that
     * carries the kitty interceptor and the engine's own listener. See the header.
     */
    readonly captureRoot: RefObject<HTMLElement | null>;
    /** Drop the caret inside the pane, which is what dismisses the software keyboard. */
    readonly hideKeyboard: () => void;
}

/** The modifiers that must never be "the next key" - holding one is not spending the latch. */
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock']);

/**
 * The named keys a software keyboard delivers with an empty `code` (device round 2 - see the
 * header). Each one is re-raised carrying its `code`, which for every key in this set is the same
 * string as its `key`: that is the UI Events spec's own naming for the main-block Enter,
 * Backspace, Tab, Escape, Delete, the four arrows, Home and End, and it is why the rescue needs a
 * set rather than a table.
 *
 * Deliberately an ALLOWLIST and not "every key whose name is longer than one character": a key
 * this bar cannot name is left exactly where it is rather than guessed at.
 */
export const NAMED_KEYS_WITHOUT_CODE: ReadonlySet<string> = new Set([
    'Enter',
    'Backspace',
    'Tab',
    'Escape',
    'Delete',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End'
]);

/**
 * The `beforeinput` types that ARE the Enter key when no key event carried it.
 *
 * `insertLineBreak` is what a textarea reports; `insertParagraph` is what a contenteditable does,
 * and some Android keyboards send it for a hidden input anyway. The engine forwards neither
 * (`handleBeforeInput` takes `insertText` alone), so both are dropped today.
 */
export const LINE_BREAK_INPUT_TYPES: ReadonlySet<string> = new Set(['insertLineBreak', 'insertParagraph']);

/**
 * The US layout, as the one thing a character cannot tell you about itself: which physical key it
 * came from.
 *
 * The engine maps `KeyboardEvent.code` to a USB HID key, so a letter arriving through
 * `beforeinput` (which carries no `code` at all, only the character) has to be given one before
 * it can be re-raised with a modifier on it. `shiftKey` comes with it for the same reason
 * `KEY_BAR_KEYS` puts it on `|`: on a US keyboard the bar character IS Shift+Backslash, and the
 * event a physical keyboard raises carries the modifier.
 *
 * US-only, and that is a bounded limit rather than an oversight: a `code` is a physical POSITION,
 * so no table can be right for every layout, and the character itself still travels as `key`,
 * which is what the encoder turns into bytes. The worst a wrong `code` can do here is name the
 * wrong position for a modified punctuation key; the letters and digits, which is what a latched
 * Ctrl or Alt is used with, are the same position on every Latin layout.
 */
const US_CHARACTER_KEYS: readonly (readonly [code: string, plain: string, shifted: string | null])[] = [
    ['Backquote', '`', '~'],
    ['Digit1', '1', '!'],
    ['Digit2', '2', '@'],
    ['Digit3', '3', '#'],
    ['Digit4', '4', '$'],
    ['Digit5', '5', '%'],
    ['Digit6', '6', '^'],
    ['Digit7', '7', '&'],
    ['Digit8', '8', '*'],
    ['Digit9', '9', '('],
    ['Digit0', '0', ')'],
    ['Minus', '-', '_'],
    ['Equal', '=', '+'],
    ['BracketLeft', '[', '{'],
    ['BracketRight', ']', '}'],
    ['Backslash', '\\', '|'],
    ['Semicolon', ';', ':'],
    ['Quote', "'", '"'],
    ['Comma', ',', '<'],
    ['Period', '.', '>'],
    ['Slash', '/', '?'],
    ['Space', ' ', null]
];

/** What a re-raised character needs beyond its own `key`. */
export interface CharacterKey {
    readonly code: string;
    readonly shiftKey: boolean;
}

const CHARACTER_KEYS = ((): ReadonlyMap<string, CharacterKey> => {
    const map = new Map<string, CharacterKey>();
    for (let index = 0; index < 26; index++) {
        const upper = String.fromCharCode(65 + index);
        map.set(upper.toLowerCase(), { code: `Key${upper}`, shiftKey: false });
        map.set(upper, { code: `Key${upper}`, shiftKey: true });
    }
    for (const [code, plain, shifted] of US_CHARACTER_KEYS) {
        map.set(plain, { code, shiftKey: false });
        if (shifted !== null) map.set(shifted, { code, shiftKey: true });
    }
    return map;
})();

/**
 * The key a character comes from on a US layout, or null for anything not on one (an accented
 * letter, an emoji, a CJK glyph). Null means "leave it alone": there is no `code` to give it, and
 * an event with no `code` and a modifier on it is dropped by the engine outright.
 */
export function characterKey(character: string): CharacterKey | null {
    return CHARACTER_KEYS.get(character) ?? null;
}

/**
 * How long after a consumed keydown its paired `beforeinput` is still recognisable as the same
 * keystroke. Deliberately the same order as the engine's own dedupe window
 * (`input-handler.ts` `BEFORE_INPUT_IGNORE_MS`), and for the same reason: it is a pairing
 * heuristic over one keystroke, not a lockout.
 */
export const CONSUMED_INPUT_WINDOW_MS = 100;

/** `init` plus whatever is latched. A key's own modifier (`|`'s Shift) is never taken away. */
export function withSticky(init: TerminalKeyInit, sticky: StickyModifiers): TerminalKeyInit {
    return {
        ...init,
        ctrlKey: sticky.ctrl || init.ctrlKey === true,
        altKey: sticky.alt || init.altKey === true
    };
}

export function KeyBar({ paneID, sendKey, captureRoot, hideKeyboard }: KeyBarProps): ReactElement {
    const [sticky, setSticky] = useState<StickyModifiers>(NO_STICKY);
    /**
     * The ref is the AUTHORITY and the state is only for painting. The interceptor below clears
     * the latch and re-raises the key in the same synchronous turn, so the re-raised event
     * re-enters the listener before React has re-rendered; reading state there would see the
     * modifier still armed and apply it twice, forever.
     */
    const stickyRef = useRef<StickyModifiers>(NO_STICKY);
    const sendKeyRef = useRef(sendKey);
    sendKeyRef.current = sendKey;
    /** The last keystroke the interceptor consumed - read by the `beforeinput` effect below. */
    const consumedRef = useRef<{ data: string; at: number } | null>(null);
    /**
     * When an Enter `keydown` last travelled the pane root, consumed here or not.
     *
     * The line-break `beforeinput` below is the SAME keystroke when one has just gone past, and a
     * second `\r` at the PTY is a second command. Recorded for every Enter rather than only for
     * the ones this bar re-raised, so the engine's own handling of a physical Enter (which
     * cancels the keydown, and therefore should raise no `beforeinput` at all) cannot be
     * double-counted if a keyboard raises one anyway - which is exactly what a cancelled keydown
     * was measured doing for the letter case on 2026-09-03.
     */
    const enterSeenRef = useRef<number | null>(null);

    const setLatch = useCallback((next: StickyModifiers): void => {
        stickyRef.current = next;
        setSticky(next);
    }, []);

    /**
     * Who held the caret when the finger went down - the belt to `preventDefault`'s braces.
     *
     * `preventDefault()` on the pointer-down is what SHOULD stop a tap moving focus, and for a
     * mouse it always does. For a touch it is a weaker promise: focus on a phone is set by the
     * tap GESTURE, which the recognizer builds from touchstart/touchend, and cancelling
     * touchstart instead would take the synthesized `click` with it (Pointer Events exempts
     * `click` from a cancelled pointerdown, `touchstart` does not). So the element that had the
     * caret is remembered on the way down and handed it back on the way out if anything moved it.
     * A no-op when the pointer-down did its job, which is the common case.
     */
    const caretRef = useRef<Element | null>(null);
    const holdCaret = useCallback((event: { preventDefault: () => void }): void => {
        event.preventDefault();
        caretRef.current = typeof document === 'undefined' ? null : document.activeElement;
    }, []);
    const restoreCaret = useCallback((): void => {
        const held = caretRef.current;
        if (!(held instanceof HTMLElement) || !held.isConnected) return;
        if (document.activeElement === held) return;
        held.focus();
    }, []);

    // ── the keydown interceptor: latched modifiers, and named keys with no `code` ────
    //
    // Bound for the life of the bar, which is the phone form factor and nothing else: the pane
    // only renders a bar when `formFactor === 'phone'` (TerminalPane's `showKeyBar`), so a
    // desktop window, an Electron shell and a tablet never reach this listener at all. It used to
    // be bound only while a modifier was armed; the soft keyboard's Enter (device round 2) is not
    // a latch problem and arrives with nothing latched, so the binding follows the bar.
    //
    // What it does NOT touch is as load-bearing as what it does: an event that carries a real
    // `code` and finds nothing latched returns on the first branch, so a PHYSICAL keyboard on the
    // phone types exactly the path it types today.
    useEffect(() => {
        const root = captureRoot.current;
        if (root === null) return;

        /** Cancel this keystroke and re-raise it at the engine as `init` says it should be. */
        const reraise = (event: KeyboardEvent, key: string, code: string, shiftKey: boolean, latch: StickyModifiers): void => {
            event.preventDefault();
            // The immediate form, for the same reason §TERM-030 uses it: the engine may hold more
            // than one listener on the way down and only this guarantees none of them runs.
            event.stopImmediatePropagation();
            // Remember the character, so the `beforeinput` this keystroke may still raise can be
            // recognised as the SAME keystroke and dropped - see the effect below.
            consumedRef.current = key.length === 1 ? { data: key, at: Date.now() } : null;
            // Clear BEFORE re-raising: the synthetic event walks past this listener again, and it
            // must find the latch already spent.
            setLatch(NO_STICKY);
            sendKeyRef.current({
                key,
                code,
                ctrlKey: latch.ctrl || event.ctrlKey,
                altKey: latch.alt || event.altKey,
                shiftKey,
                metaKey: event.metaKey,
                location: event.location,
                repeat: event.repeat
            });
        };

        const onKeyDown = (event: KeyboardEvent): void => {
            // Before every early return: the line-break `beforeinput` this keystroke may raise
            // has to know an Enter already went past, whoever ends up handling it.
            if (event.key === 'Enter') enterSeenRef.current = Date.now();
            const latch = stickyRef.current;
            const latched = latch.ctrl || latch.alt;
            // A modifier held on a hardware keyboard is not the key the latch is waiting for.
            if (MODIFIER_KEYS.has(event.key)) return;
            // Mid-composition the key belongs to the IME, which owns its own commit; taking it
            // here would break Korean/Japanese input for the sake of a latch nobody armed for it.
            // `keyCode === 229` is also the Android soft keyboard's placeholder for an ordinary
            // letter, and it carries no letter of its own: that keystroke is answered at
            // `beforeinput`, in the effect below, which is where the character actually is.
            if (event.isComposing || event.keyCode === 229) return;

            // A key the engine can already map. Only a latched modifier is a reason to touch it.
            if (event.code !== '') {
                if (!latched) return;
                reraise(event, event.key, event.code, event.shiftKey, latch);
                return;
            }

            // …and from here down the key has NO `code`, which is the soft keyboard's shape.
            if (NAMED_KEYS_WITHOUT_CODE.has(event.key)) {
                // Named keys are rescued whether or not anything is latched: with an empty `code`
                // the engine drops them outright, which is why Enter never reached the PTY.
                reraise(event, event.key, event.key, event.shiftKey, latch);
                return;
            }
            const character = event.key.length === 1 ? characterKey(event.key) : null;
            if (character !== null && latched) {
                reraise(event, event.key, character.code, event.shiftKey || character.shiftKey, latch);
                return;
            }
            // Nothing this bar can name. An unmodified printable is left to the engine's own
            // fallback (`input-handler.ts:391-411`), which rescues exactly that case; a latch
            // that cannot be applied is released rather than left armed to surprise the next key.
            if (latched) setLatch(NO_STICKY);
        };
        root.addEventListener('keydown', onKeyDown, true);
        return () => root.removeEventListener('keydown', onKeyDown, true);
    }, [captureRoot, setLatch]);

    /**
     * …and the OTHER half of a keystroke, which a cancelled keydown does not always take with it.
     *
     * A key that goes through the interceptor above has already been re-raised with its modifier,
     * so the `beforeinput` the same keystroke may still produce is a duplicate of a key that was
     * handled - and the engine's own dedupe cannot see that, because it compares against the
     * BYTES it last emitted (`input-handler.ts:519-526`), which for a modified key are `0x03`, not
     * `c`. Measured on 2026-09-03 in the `phone-key-bar` audit step: with a latched Ctrl and the
     * letter typed, the PTY received the interrupt AND then the letter, and the capture read
     * `interrupt-me^C` / `sh-3.2$ cprintf …`. The harness makes the pairing explicit by
     * dispatching the `char` itself, and a software keyboard is the class of input that does the
     * same thing for its own reasons.
     *
     * Bound for the life of the bar rather than only while something is latched: the latch is
     * spent inside the keydown, so by the time the `beforeinput` lands nothing is armed any more.
     *
     * It is also where the SOFT keyboard's keystrokes are answered, because for Android that is
     * the half of the keystroke that carries the character at all (device round 2 - see the
     * header): a latched modifier is applied to `insertText`, and a line break becomes Enter.
     * Both re-raise a `keydown` at the engine rather than writing bytes, so DECCKM, the kitty
     * protocol and the pane's own interceptor decide the encoding exactly as they do for a
     * physical key. Everything else - plain typing, an IME's composition, a paste - is left
     * alone, which is why the engine still inserts an unmodified letter itself.
     */
    useEffect(() => {
        const root = captureRoot.current;
        if (root === null) return;
        const onBeforeInput = (event: Event): void => {
            const input = event as InputEvent;
            const now = Date.now();

            // 1. The other half of a keystroke the keydown listener already consumed.
            const consumed = consumedRef.current;
            if (consumed !== null) {
                if (now - consumed.at > CONSUMED_INPUT_WINDOW_MS) consumedRef.current = null;
                else if (input.data === consumed.data) {
                    consumedRef.current = null;
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    return;
                }
            }

            // 2. A line break: the soft keyboard's Enter when no key event carried it.
            if (LINE_BREAK_INPUT_TYPES.has(input.inputType)) {
                // Cancelled either way. The engine ignores this input type, so letting it through
                // sends nothing and only risks the textarea taking a newline of its own.
                event.preventDefault();
                event.stopImmediatePropagation();
                const seenAt = enterSeenRef.current;
                if (seenAt !== null && now - seenAt <= CONSUMED_INPUT_WINDOW_MS) {
                    // The keydown half of this same keystroke already went past; a second `\r` at
                    // the PTY would be a second command.
                    enterSeenRef.current = null;
                    return;
                }
                const latch = stickyRef.current;
                setLatch(NO_STICKY);
                sendKeyRef.current({ key: 'Enter', code: 'Enter', ctrlKey: latch.ctrl, altKey: latch.alt });
                return;
            }

            // 3. A letter typed on the soft keyboard while a modifier is latched. This is the
            //    whole of "Ctrl then c": the keydown that preceded it was keyCode 229 with an
            //    empty `code` and `key` `'Unidentified'`, and the letter is here.
            const latch = stickyRef.current;
            if (!latch.ctrl && !latch.alt) return;
            if (input.inputType !== 'insertText') return;
            // A suggestion strip inserting a whole word, or a glyph no US key produces: there is
            // no single key to put a modifier on, so the latch is released and the text is left
            // to the engine, which inserts it itself.
            const data = input.data;
            if (data === null || data.length !== 1) {
                setLatch(NO_STICKY);
                return;
            }
            const character = characterKey(data);
            if (character === null) {
                setLatch(NO_STICKY);
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            setLatch(NO_STICKY);
            sendKeyRef.current({
                key: data,
                code: character.code,
                ctrlKey: latch.ctrl,
                altKey: latch.alt,
                shiftKey: character.shiftKey
            });
        };
        root.addEventListener('beforeinput', onBeforeInput, true);
        return () => root.removeEventListener('beforeinput', onBeforeInput, true);
    }, [captureRoot, setLatch]);

    // A pane that loses its engine (or its bar) must not leave a latch behind for the next one.
    useEffect(() => () => setLatch(NO_STICKY), [setLatch]);

    const press = useCallback(
        (key: KeyBarKey): void => {
            // The one key that must NOT get the caret back: dismissing the keyboard is exactly
            // "let the caret go", and handing it back would put the keyboard straight up again.
            if (key.action === 'hideKeyboard') {
                setLatch(NO_STICKY);
                caretRef.current = null;
                hideKeyboard();
                return;
            }
            restoreCaret();
            if (key.modifier !== undefined) {
                const current = stickyRef.current;
                setLatch({ ...current, [key.modifier]: !current[key.modifier] });
                return;
            }
            // C4 owns Paste; until then the key renders disabled and never gets here.
            if (key.action !== undefined || key.init === undefined) return;
            const latch = stickyRef.current;
            setLatch(NO_STICKY);
            sendKeyRef.current(withSticky(key.init, latch));
        },
        [hideKeyboard, restoreCaret, setLatch]
    );

    return (
        <div
            data-testid={`terminal-key-bar-${paneID}`}
            {...{ [KEY_BAR_ATTR]: '' }}
            role="toolbar"
            aria-label="Terminal keys"
            aria-orientation="horizontal"
            className="flex w-full shrink-0 items-center gap-1 overflow-x-auto px-1"
            style={{
                height: KEY_BAR_HEIGHT_PX,
                borderTop: `1px solid ${tokens.divider}`,
                backgroundColor: tokens.headerBackground,
                // A horizontal drag scrolls the bar (15 keys at 44 px do not fit a 390 px phone);
                // a vertical one is left to the pane, which is where scrollback lives.
                touchAction: 'pan-x',
                scrollbarWidth: 'none'
            }}
        >
            {KEY_BAR_KEYS.map((key) => {
                const pressed = key.modifier === undefined ? undefined : sticky[key.modifier];
                const disabled = key.action === 'paste';
                return (
                    <button
                        key={key.id}
                        type="button"
                        data-testid={`terminal-key-${key.id}-${paneID}`}
                        {...{ [KEY_ATTR]: key.id }}
                        aria-label={key.name}
                        aria-pressed={pressed}
                        aria-disabled={disabled ? true : undefined}
                        disabled={disabled}
                        title={key.title}
                        /*
                         * THE TAP MUST NOT TAKE THE CARET. A button that takes focus dismisses the
                         * software keyboard and orphans the terminal, so the very first tap on Esc
                         * would close the keyboard the bar exists to sit above. `holdCaret`
                         * cancels the pointer-down (which is what suppresses the focus change) and
                         * remembers who had the caret, so `press` can hand it back if the platform
                         * moved it anyway. The `click` that follows is unaffected by a cancelled
                         * pointer-down, which is why activation still lives on `onClick`;
                         * `onMouseDown` covers a browser with no pointer events.
                         */
                        onPointerDown={holdCaret}
                        onMouseDown={holdCaret}
                        onClick={() => press(key)}
                        className="flex shrink-0 items-center justify-center rounded text-sm font-medium whitespace-nowrap"
                        style={{
                            minWidth: key.wide === true ? KEY_BAR_KEY_SIZE_PX + 12 : KEY_BAR_KEY_SIZE_PX,
                            height: KEY_BAR_KEY_SIZE_PX,
                            padding: '0 8px',
                            border: `1px solid ${tokens.divider}`,
                            backgroundColor: pressed === true ? tokens.accent : tokens.surfaceBackground,
                            color: disabled
                                ? tokens.textTertiary
                                : pressed === true
                                  ? tokens.windowBackground
                                  : tokens.textPrimary
                        }}
                    >
                        {key.label}
                    </button>
                );
            })}
        </div>
    );
}
