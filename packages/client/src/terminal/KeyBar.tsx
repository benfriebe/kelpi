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
 *
 * ## THE BAR NEVER FOCUSES ANYTHING
 *
 * Device round 3 (2026-09-04, same phone) found the previous cut of this file summoning the
 * software keyboard on EVERY tap, including right after the person had dismissed it: the bar was
 * unusable for driving vim, less, or a prompt with the keyboard down.
 *
 * The mechanism was the caret restore this file used to carry. A tap remembered
 * `document.activeElement` at pointer-down and called `held.focus()` afterwards if the platform
 * had moved focus to the button, which on a desktop is invisible bookkeeping and on Android is
 * the gesture that RAISES the keyboard: focusing an editable element is how a soft keyboard is
 * summoned, and `preventDefault()` on a pointer-down does not reliably keep focus on the textarea
 * for a touch tap. So the bar took the caret and then handed it back, and the keyboard came up.
 *
 * The rule now, and it is absolute: **nothing in the bar calls `focus()` except the keyboard
 * toggle, which exists because the person asked for the keyboard.** Everything else works whether
 * or not the caret is anywhere near the terminal:
 *
 *   - a key is dispatched AT the engine's textarea (`renderer.dispatchKey`, which resolves it
 *     through `engineKeyTarget` and never focuses it). The engine binds `keydown` on the
 *     CONTAINER, so an event dispatched at a blurred textarea still bubbles to it and is encoded
 *     exactly as it would be with the caret there; measured in `KeyBar.test.tsx` against the real
 *     engine with `document.activeElement === document.body`;
 *   - the keys are `tabIndex={-1}` and still cancel their own pointer-down, so a tap leaves the
 *     caret alone as far as a platform allows. **The design does not depend on that**, which is
 *     the whole point of the paragraph above: if Android moves focus to the button anyway, the
 *     keystroke still lands, and the keyboard is the person's to bring back;
 *   - `touch-action: manipulation` on each key, so a fast second tap is a second key and never a
 *     double-tap zoom.
 *
 * The keyboard key is therefore a TOGGLE rather than a one-way dismiss: it hides when the engine
 * holds the caret and shows when it does not, and which one it is comes from `focusin`/`focusout`
 * on the pane root rather than from a flag this file keeps. Tapping the terminal itself still
 * raises the keyboard through the engine's own `touchend` handler
 * (`vendor/ghostty-web-patched/source/lib/terminal.ts:490-493`), which nothing here touches.
 *
 * C4's two transient surfaces keep their own rules: the fallback paste field focuses ITSELF when
 * it opens, because a field nobody can type into is not a paste affordance, and the Copy pill
 * only cancels its pointer-down like every other button here.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement, type RefObject } from 'react';

import { tokens } from '../chrome/tokens';
import { onClipboardOffer } from '../state/clipboard';
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

/** C4: the OSC 52 Copy pill, and the fallback paste field. Both sit ABOVE the bar. */
export const COPY_PILL_ATTR = 'data-terminal-copy-pill';
export const PASTE_FIELD_ATTR = 'data-terminal-paste-field';

/** How long the Copy pill stays up before it takes itself away (C4). */
export const COPY_PILL_TIMEOUT_MS = 6_000;

/**
 * Put `text` into the terminal the way the ENGINE's own paste does (C4).
 *
 * A synthesized `paste` ClipboardEvent on the engine's input, for the same reason C1's keys are
 * synthesized `keydown`s: it is the only way to be byte-identical rather than nearly right. The
 * vendored engine binds a `paste` listener on its own textarea
 * (`vendor/ghostty-web-patched/source/lib/terminal.ts:596-604`) which calls `Terminal.paste()`,
 * and THAT is where the bracketed-paste envelope is decided - `hasBracketedPaste()` off the live
 * WASM terminal, wrapping in `ESC [ 200 ~` / `ESC [ 201 ~` when DEC 2004 is set and sending the
 * text bare when it is not (`terminal.ts:724-741`). The listener also `stopPropagation()`s, so
 * the InputHandler's container-level paste path (which would send raw) never runs.
 *
 * Measured against the real engine in `KeyBar.test.tsx`: the same text comes out
 * `1b 5b 32 30 30 7e … 1b 5b 32 30 31 7e` under `ESC [ ? 2004 h` and bare without it.
 *
 * Two event shapes, because the constructor is not everywhere. Where `ClipboardEvent` and
 * `DataTransfer` exist (every browser this ships to) a real one is built. Where they do not
 * - jsdom, and any engine whose `ClipboardEvent` ignores the `clipboardData` init - a plain
 * `Event` carrying a `clipboardData` with the one method the engine calls stands in. Both reach
 * the same listener, which is what the fallback has to be judged on.
 */
export function dispatchPaste(target: HTMLElement | null, text: string): boolean {
    if (target === null || text === '') return false;
    const view = target.ownerDocument.defaultView;
    if (view === null) return false;
    let event: Event | null = null;
    try {
        if (typeof view.ClipboardEvent === 'function' && typeof view.DataTransfer === 'function') {
            const data = new view.DataTransfer();
            data.setData('text/plain', text);
            const real = new view.ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
            // Some engines accept the init member and hand back a null `clipboardData` anyway;
            // an event the engine reads nothing off is worse than the stand-in below.
            if (real.clipboardData !== null) event = real;
        }
    } catch {
        // A constructor that refuses the init is the stand-in's case, not an error.
    }
    if (event === null) {
        event = new view.Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', {
            value: { getData: (): string => text }
        });
    }
    target.dispatchEvent(event);
    return true;
}

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
    readonly action?: 'paste' | 'toggleKeyboard' | undefined;
    /** Render the label wider than a single glyph (Esc, Tab, Home, End, Paste, Hide). */
    readonly wide?: boolean | undefined;
}

/**
 * The keyboard key's two faces (device round 3 - see the header).
 *
 * It is one button in one place, and what it does depends on where the caret is: with the engine
 * holding it, tapping hides the software keyboard; with the caret anywhere else, tapping brings it
 * back. The id stays `hide-keyboard` because the audit step and the sibling lanes select on it and
 * a rename would break them for no gain in truth.
 */
export const KEYBOARD_TOGGLE_HIDE = {
    label: 'Hide',
    name: 'Hide keyboard',
    title: 'Hide the software keyboard; this key or a tap on the terminal brings it back'
} as const;

export const KEYBOARD_TOGGLE_SHOW = {
    label: 'Show',
    name: 'Show keyboard',
    title: 'Show the software keyboard; the bar works with it down'
} as const;

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
    {
        id: 'paste',
        label: 'Paste',
        name: 'Paste',
        title: 'Paste the clipboard into the terminal',
        action: 'paste',
        wide: true
    },
    {
        id: 'hide-keyboard',
        label: KEYBOARD_TOGGLE_HIDE.label,
        name: KEYBOARD_TOGGLE_HIDE.name,
        title: KEYBOARD_TOGGLE_HIDE.title,
        action: 'toggleKeyboard',
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
    /**
     * Put the caret back on the engine's input, which is what RAISES the software keyboard.
     *
     * The one focus the bar is allowed (device round 3): it happens only from the keyboard
     * toggle, which is the person asking for the keyboard in as many words. Nothing else in this
     * file focuses anything.
     */
    readonly showKeyboard: () => void;
    /**
     * C4 - put text into the terminal through the engine's own paste path (bracketed when the
     * application asked for it). The pane supplies it because the pane owns the host.
     */
    readonly pasteText: (text: string) => boolean;
    /**
     * C4 test seam: how the clipboard is READ, defaulting to `navigator.clipboard.readText`.
     * Null means this page has no clipboard read at all, which is the fallback field's case.
     */
    readonly readClipboard?: (() => Promise<string>) | null | undefined;
    /** C4 test seam: how the Copy pill WRITES, defaulting to `navigator.clipboard.writeText`. */
    readonly writeClipboard?: ((text: string) => Promise<void>) | null | undefined;
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

/** `navigator.clipboard.readText`, or null on a page that has none (insecure context, old engine). */
function defaultClipboardReader(): (() => Promise<string>) | null {
    const clipboard = (globalThis.navigator as Navigator | undefined)?.clipboard;
    if (clipboard?.readText === undefined) return null;
    return () => clipboard.readText();
}

/** `navigator.clipboard.writeText`, or null. The Copy pill's writer. */
function defaultClipboardWriter(): ((text: string) => Promise<void>) | null {
    const clipboard = (globalThis.navigator as Navigator | undefined)?.clipboard;
    if (clipboard?.writeText === undefined) return null;
    return (text) => clipboard.writeText(text);
}

export function KeyBar({
    paneID,
    sendKey,
    captureRoot,
    hideKeyboard,
    showKeyboard,
    pasteText,
    readClipboard,
    writeClipboard
}: KeyBarProps): ReactElement {
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
     * Ask the platform not to move the caret to the button, and then stop caring.
     *
     * `preventDefault()` on the pointer-down is what SHOULD suppress the focus change, and for a
     * mouse it always does. For a touch it is a weaker promise: focus on a phone is set by the
     * tap GESTURE, which the recognizer builds from touchstart/touchend, and cancelling
     * touchstart instead would take the synthesized `click` with it (Pointer Events exempts
     * `click` from a cancelled pointerdown, `touchstart` does not).
     *
     * This used to be half of a hold-and-restore pair. The restore is GONE (device round 3): a
     * `focus()` back onto the engine's textarea is how Android summons the software keyboard, so
     * the restore raised the keyboard on every tap, including immediately after the person had
     * dismissed it. Nothing replaces it, because nothing needs to: a key is dispatched at the
     * textarea whether or not it holds the caret.
     */
    const suppressFocus = useCallback((event: { preventDefault: () => void }): void => {
        event.preventDefault();
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

    // ── C4: paste ───────────────────────────────────────────────────────────────────

    const pasteTextRef = useRef(pasteText);
    pasteTextRef.current = pasteText;
    /** The fallback field is up, because the clipboard could not be read from a tap. */
    const [pasteFieldOpen, setPasteFieldOpen] = useState(false);
    const pasteFieldRef = useRef<HTMLTextAreaElement | null>(null);

    /**
     * Read the clipboard INSIDE the tap, which is the whole reason this lives on the click and
     * not behind a promise chain that starts later: every browser gates `readText` on transient
     * activation, and on iOS it additionally raises its own one-tap Paste confirmation, which is
     * only offered to a gesture.
     *
     * A refusal is not an error to report, it is a different UI: an insecure context has no
     * `navigator.clipboard` at all, a permission prompt can be dismissed, and a browser can
     * simply say no. All three land on the same fallback - a small field, focused, that takes
     * whatever the platform's own paste puts in it.
     */
    const requestPaste = useCallback((): void => {
        const read = readClipboard === undefined ? defaultClipboardReader() : readClipboard;
        if (read === null) {
            setPasteFieldOpen(true);
            return;
        }
        void read().then(
            (text) => {
                if (text === '') return;
                pasteTextRef.current(text);
            },
            () => setPasteFieldOpen(true)
        );
    }, [readClipboard]);

    // Focus the field the moment it exists: it is the caret's whole purpose, and on a phone a
    // field that is not focused is a field with no keyboard and no paste menu.
    useEffect(() => {
        if (!pasteFieldOpen) return;
        pasteFieldRef.current?.focus();
    }, [pasteFieldOpen]);

    const acceptFallbackPaste = useCallback((text: string): void => {
        setPasteFieldOpen(false);
        if (text === '') return;
        pasteTextRef.current(text);
    }, []);

    // ── C4: the Copy pill ───────────────────────────────────────────────────────────

    /**
     * An OSC 52 copy a program in THIS pane made, waiting for the tap that can put it on the
     * clipboard (`state/clipboard.ts` `onClipboardOffer`).
     *
     * `seq` is what re-arms the timer: two copies of the same text are two offers, and a
     * value-equal object alone would leave the first one's countdown running.
     */
    const [offer, setOffer] = useState<{ text: string; bytes: number; seq: number } | null>(null);
    useEffect(() => {
        let seq = 0;
        return onClipboardOffer((incoming) => {
            if (incoming.paneID !== paneID) return;
            seq += 1;
            setOffer({ text: incoming.text, bytes: incoming.bytes, seq });
        });
    }, [paneID]);

    useEffect(() => {
        if (offer === null) return;
        const timer = setTimeout(() => setOffer(null), COPY_PILL_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [offer]);

    const takeOffer = useCallback((): void => {
        const text = offer?.text ?? '';
        setOffer(null);
        if (text === '') return;
        const write = writeClipboard === undefined ? defaultClipboardWriter() : writeClipboard;
        // Best-effort, exactly as `state/clipboard.ts` is: the tap supplies the activation the
        // pane's own output could not, and a browser that still refuses is not worth a modal.
        void write?.(text).catch(() => undefined);
    }, [offer, writeClipboard]);

    // ── the keyboard toggle's state (device round 3) ────────────────────────────────
    //
    // OBSERVED, never assumed. The software keyboard is up when the engine's input holds the
    // caret, and that is a fact about the DOM, not a flag this file can keep: the engine's own
    // `touchend` raises the keyboard when the terminal is tapped (`terminal.ts:490-493`), the
    // pane's focus effects move the caret for reasons of their own, and a platform can take it
    // away without telling anyone. So the state is read off `document.activeElement` whenever
    // focus moves anywhere inside the pane.
    //
    // "The engine's input" is a `<textarea>` inside the pane that is not C4's paste field: the
    // engine opens exactly one (`renderer.ts` `engineKeyTarget` resolves the same node), and the
    // paste field is the bar's own surface, which focuses itself on purpose and must not read as
    // the terminal having the caret.
    const isEngineCaret = useCallback((): boolean => {
        const root = captureRoot.current;
        if (root === null || typeof document === 'undefined') return false;
        const active = document.activeElement;
        if (!(active instanceof HTMLElement)) return false;
        if (active === pasteFieldRef.current) return false;
        return active.tagName === 'TEXTAREA' && root.contains(active);
    }, [captureRoot]);

    const [keyboardShown, setKeyboardShown] = useState(false);
    const keyboardShownRef = useRef(false);
    useEffect(() => {
        const root = captureRoot.current;
        if (root === null) return;
        const sync = (): void => {
            const shown = isEngineCaret();
            keyboardShownRef.current = shown;
            setKeyboardShown(shown);
        };
        sync();
        // Capture phase, and both events: `focusout` is what says the caret LEFT (its
        // `document.activeElement` is the body mid-dispatch, which is the answer we want), and
        // `focusin` corrects it the moment something else takes the caret. Both bubble, so the
        // pane root sees every move inside the pane, including the engine's own.
        root.addEventListener('focusin', sync, true);
        root.addEventListener('focusout', sync, true);
        return () => {
            root.removeEventListener('focusin', sync, true);
            root.removeEventListener('focusout', sync, true);
        };
    }, [captureRoot, isEngineCaret]);

    const press = useCallback(
        (key: KeyBarKey): void => {
            // THE ONE FOCUS THE BAR IS ALLOWED, and only in one direction: the person tapped a
            // key that says "Show", which is them asking for the keyboard. With the caret on the
            // engine the same key is a dismiss, exactly as before.
            if (key.action === 'toggleKeyboard') {
                setLatch(NO_STICKY);
                if (keyboardShownRef.current) hideKeyboard();
                else showKeyboard();
                return;
            }
            if (key.modifier !== undefined) {
                const current = stickyRef.current;
                setLatch({ ...current, [key.modifier]: !current[key.modifier] });
                return;
            }
            if (key.action === 'paste') {
                requestPaste();
                return;
            }
            if (key.action !== undefined || key.init === undefined) return;
            const latch = stickyRef.current;
            setLatch(NO_STICKY);
            sendKeyRef.current(withSticky(key.init, latch));
        },
        [hideKeyboard, requestPaste, setLatch, showKeyboard]
    );

    return (
        <>
            {/*
             * The two transient surfaces sit ABOVE the bar and OVER the terminal, absolutely
             * positioned against the pane root's own `relative`. Deliberately not in flow: the
             * bar's 45 px is a contract C2 and C3 lay out against, and a pill that changed the
             * terminal's height would resize the PTY for four seconds and then resize it back.
             */}
            {offer !== null ? (
                <div
                    data-testid={`terminal-copy-pill-${paneID}`}
                    {...{ [COPY_PILL_ATTR]: '' }}
                    role="status"
                    className="absolute right-2 left-2 z-10 flex items-center justify-center"
                    style={{ bottom: KEY_BAR_HEIGHT_PX + 8 }}
                >
                    <button
                        type="button"
                        data-testid={`terminal-copy-pill-button-${paneID}`}
                        aria-label={`Copy ${String(offer.bytes)} bytes to the clipboard`}
                        title="A program in this pane copied text; tap to put it on this phone's clipboard"
                        onPointerDown={suppressFocus}
                        onMouseDown={suppressFocus}
                        onClick={takeOffer}
                        className="flex items-center justify-center rounded-full px-4 text-sm font-medium whitespace-nowrap shadow-lg"
                        style={{
                            height: KEY_BAR_KEY_SIZE_PX,
                            border: `1px solid ${tokens.divider}`,
                            backgroundColor: tokens.accent,
                            color: tokens.windowBackground
                        }}
                    >
                        {`Copy ${String(offer.bytes)} bytes`}
                    </button>
                </div>
            ) : null}
            {pasteFieldOpen ? (
                <div
                    data-testid={`terminal-paste-field-${paneID}`}
                    {...{ [PASTE_FIELD_ATTR]: '' }}
                    className="absolute right-2 left-2 z-10 flex items-center gap-2 rounded p-2"
                    style={{
                        bottom: KEY_BAR_HEIGHT_PX + 8,
                        border: `1px solid ${tokens.divider}`,
                        backgroundColor: tokens.headerBackground
                    }}
                >
                    <textarea
                        ref={pasteFieldRef}
                        data-testid={`terminal-paste-input-${paneID}`}
                        aria-label="Paste here"
                        placeholder="Paste here"
                        rows={1}
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        className="min-w-0 flex-1 rounded px-2 text-sm"
                        style={{
                            height: KEY_BAR_KEY_SIZE_PX,
                            border: `1px solid ${tokens.divider}`,
                            backgroundColor: tokens.surfaceBackground,
                            color: tokens.textPrimary
                        }}
                        onPaste={(event) => {
                            // The platform's own paste, which is the one gesture that always
                            // works: take the text off the event rather than off the field, so
                            // nothing depends on the insertion having landed yet.
                            const text = event.clipboardData.getData('text/plain');
                            event.preventDefault();
                            acceptFallbackPaste(text);
                        }}
                        onKeyDown={(event) => {
                            // The field is not the terminal, so its keys are its own: Enter sends
                            // what is in it (a platform that inserted without a `paste` event),
                            // Escape gives up. Both stop here.
                            if (event.key === 'Escape') {
                                event.preventDefault();
                                event.stopPropagation();
                                setPasteFieldOpen(false);
                                return;
                            }
                            if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault();
                                event.stopPropagation();
                                acceptFallbackPaste(event.currentTarget.value);
                            }
                        }}
                    />
                    <button
                        type="button"
                        data-testid={`terminal-paste-cancel-${paneID}`}
                        aria-label="Cancel paste"
                        title="Cancel paste"
                        onPointerDown={(event) => event.preventDefault()}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => setPasteFieldOpen(false)}
                        className="flex shrink-0 items-center justify-center rounded"
                        style={{
                            minWidth: KEY_BAR_KEY_SIZE_PX,
                            height: KEY_BAR_KEY_SIZE_PX,
                            border: `1px solid ${tokens.divider}`,
                            backgroundColor: tokens.surfaceBackground,
                            color: tokens.textPrimary
                        }}
                    >
                        {'×'}
                    </button>
                </div>
            ) : null}
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
                    // A horizontal drag scrolls the bar (15 keys at 44 px do not fit a 390 px
                    // phone); a vertical one is left to the pane, where scrollback lives.
                    touchAction: 'pan-x',
                    scrollbarWidth: 'none'
                }}
            >
                {KEY_BAR_KEYS.map((key) => {
                    // The keyboard key is one button with two faces, and which one it wears comes
                    // from where the caret actually is (device round 3). Its `aria-pressed` means
                    // "the software keyboard is up", which is the state the label describes.
                    const toggle = key.action === 'toggleKeyboard';
                    const face = !toggle ? key : keyboardShown ? KEYBOARD_TOGGLE_HIDE : KEYBOARD_TOGGLE_SHOW;
                    const pressed = toggle ? keyboardShown : key.modifier === undefined ? undefined : sticky[key.modifier];
                    const lit = key.modifier !== undefined && pressed === true;
                    return (
                        <button
                            key={key.id}
                            type="button"
                            data-testid={`terminal-key-${key.id}-${paneID}`}
                            {...{ [KEY_ATTR]: key.id }}
                            aria-label={face.name}
                            aria-pressed={pressed}
                            title={face.title}
                            /*
                             * THE TAP MUST NOT TAKE THE CARET, and if it takes it anyway nothing
                             * breaks. `suppressFocus` cancels the pointer-down, which is what
                             * suppresses the focus change on every platform that honours it, and
                             * `tabIndex={-1}` keeps the key out of the sequential focus order for
                             * the rest. There is no restore behind them any more: handing the
                             * caret back is how the previous cut summoned the software keyboard on
                             * every tap (device round 3), and a key reaches the engine whether or
                             * not the textarea is focused. The `click` that follows is unaffected
                             * by a cancelled pointer-down, which is why activation still lives on
                             * `onClick`; `onMouseDown` covers a browser with no pointer events.
                             */
                            tabIndex={-1}
                            onPointerDown={suppressFocus}
                            onMouseDown={suppressFocus}
                            onClick={() => press(key)}
                            className="flex shrink-0 items-center justify-center rounded text-sm font-medium whitespace-nowrap"
                            style={{
                                minWidth: key.wide === true ? KEY_BAR_KEY_SIZE_PX + 12 : KEY_BAR_KEY_SIZE_PX,
                                height: KEY_BAR_KEY_SIZE_PX,
                                padding: '0 8px',
                                border: `1px solid ${tokens.divider}`,
                                // A key is a tap target and nothing else: no double-tap zoom, no
                                // 300 ms wait for one, whatever the bar's own `pan-x` allows
                                // around it.
                                touchAction: 'manipulation',
                                backgroundColor: lit ? tokens.accent : tokens.surfaceBackground,
                                color: lit ? tokens.windowBackground : tokens.textPrimary
                            }}
                        >
                            {face.label}
                        </button>
                    );
                })}
            </div>
        </>
    );
}
