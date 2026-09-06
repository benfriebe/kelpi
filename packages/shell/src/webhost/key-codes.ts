/**
 * macOS virtual key code → `KeyboardEvent.code`, for the chord relay (issue #33).
 *
 * A `keybind` line stores a **physical** key by macOS key code (`super+d` is key code 2), and
 * that is the identity `@kelpi/core/config` hands back in a `KeyTrigger`. The relay's wire
 * format (`./keys.ts` ▸ `chordCommand`) speaks `KeyboardEvent.code`, because that is what the
 * client's dispatcher matches on. So deriving the forwarded set from the binding map needs
 * exactly one table: the bridge between the two.
 *
 * The client owns the FORWARD direction of the same bridge (`client/src/chrome/keys.ts` ▸
 * `CODE_TO_KEY_CODE`) and cannot be imported here: `@kelpi/shell` depends on `@kelpi/core`,
 * `@kelpi/daemon` and `@kelpi/protocol`, and adding an edge to `@kelpi/client` would pull a
 * React bundle into the Electron main process for one `Map`. What keeps the two honest instead
 * is the third party they already agree with: `@kelpi/core/config`'s `KEY_NAME_TO_CODE` is the
 * source both tables were written from, and `./key-codes.test.ts` asserts this one covers every
 * key code that table can produce - so no `keybind` line a user can write is silently
 * unrepresentable on the wire.
 *
 * Two key codes are ambiguous in the client's table and resolved here the only way that can
 * reach it: 36 is both `Enter` and `NumpadEnter` (the client maps both to 36, so `Enter` is
 * enough), and 51 is `Backspace` (`delete` in config-file spelling - macOS's ⌫), while 117 is
 * `Delete` (`forward_delete`, ⌦).
 */

import { KEY_NAME_TO_CODE } from '@kelpi/core/config';

const KEY_CODE_TO_DOM_CODE: ReadonlyMap<number, string> = new Map([
    [0, 'KeyA'], [11, 'KeyB'], [8, 'KeyC'], [2, 'KeyD'], [14, 'KeyE'], [3, 'KeyF'],
    [5, 'KeyG'], [4, 'KeyH'], [34, 'KeyI'], [38, 'KeyJ'], [40, 'KeyK'], [37, 'KeyL'],
    [46, 'KeyM'], [45, 'KeyN'], [31, 'KeyO'], [35, 'KeyP'], [12, 'KeyQ'], [15, 'KeyR'],
    [1, 'KeyS'], [17, 'KeyT'], [32, 'KeyU'], [9, 'KeyV'], [13, 'KeyW'], [7, 'KeyX'],
    [16, 'KeyY'], [6, 'KeyZ'],
    [18, 'Digit1'], [19, 'Digit2'], [20, 'Digit3'], [21, 'Digit4'], [23, 'Digit5'],
    [22, 'Digit6'], [26, 'Digit7'], [28, 'Digit8'], [25, 'Digit9'], [29, 'Digit0'],
    [36, 'Enter'], [48, 'Tab'], [53, 'Escape'], [49, 'Space'],
    [51, 'Backspace'], [117, 'Delete'],
    [123, 'ArrowLeft'], [124, 'ArrowRight'], [125, 'ArrowDown'], [126, 'ArrowUp'],
    [33, 'BracketLeft'], [30, 'BracketRight'], [41, 'Semicolon'], [39, 'Quote'],
    [50, 'Backquote'], [43, 'Comma'], [47, 'Period'], [44, 'Slash'], [42, 'Backslash'],
    [27, 'Minus'], [24, 'Equal'],
    [122, 'F1'], [120, 'F2'], [99, 'F3'], [118, 'F4'], [96, 'F5'], [97, 'F6'],
    [98, 'F7'], [100, 'F8'], [101, 'F9'], [109, 'F10'], [103, 'F11'], [111, 'F12']
]);

/** The `KeyboardEvent.code` for a config key code, or null for one no browser can name. */
export function domCodeForKeyCode(keyCode: number): string | null {
    return KEY_CODE_TO_DOM_CODE.get(keyCode) ?? null;
}

/** Every key code a `keybind` line can name - the coverage obligation, restated for the test. */
export function configurableKeyCodes(): ReadonlySet<number> {
    return new Set(KEY_NAME_TO_CODE.values());
}
