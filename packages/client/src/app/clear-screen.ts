/**
 * ⌘K, Clear Screen: Ghostty's macOS `super+k=clear_screen`, which Nex had from libghostty.
 *
 * Spec: docs/config-keybindings.md section 4 (category "Terminal"), docs/wire-protocol.md
 * `pane-clear`.
 *
 * The window only decides what the chord means; the daemon does the clearing
 * (`daemon/src/term/clear-screen.ts`), in the pane's output stream, because the screen lives in
 * the daemon's emulator and in every client's engine at once, and clearing only this window's
 * copy would leave the scrollback in every other viewer and bring it back on the next reattach.
 *
 * ## The alternate screen
 *
 * Ghostty clears nothing there and leaves the chord unconsumed (`Surface.zig` returns false for
 * `clear_screen` "so the keybind can be unconsumed"), so it reaches the key encoder. What the
 * encoder makes of it decides what Kelpi has to do to end up in the same place:
 *  - **macOS, legacy encoding**: Ghostty's encoder writes nothing for a ⌘ chord
 *    (`key_encode.zig`: super "doesn't encode text" on macOS, as Terminal.app and iTerm2 don't).
 *    Kelpi's engine would type the bare `k`, which in vim moves the cursor and in less scrolls,
 *    so the chord is taken and nothing happens: Ghostty's visible result.
 *  - **the kitty keyboard protocol is on**: the application asked to be told about ⌘ chords and
 *    Ghostty encodes `super+k` for it, so the chord falls through to Kelpi's kitty encoder,
 *    which does the same.
 *  - **off macOS**: the trigger is Ctrl+K (`super` is the primary modifier there, section 3.5),
 *    which nano, emacs and readline all use, so it falls through to the encoder as `0x0b`.
 *
 * A pane with no terminal renderer (markdown, diff, web) always falls through, so a page that
 * binds ⌘K for itself keeps it.
 */

/** The reads `clearScreenAction` needs from a pane's live renderer (`TerminalPaneHandle`). */
export interface ClearScreenTarget {
    readonly alternateScreen?: (() => boolean) | undefined;
    readonly kittyKeyboardActive?: (() => boolean) | undefined;
}

/** `clear`: ask the daemon. `swallow`: consume and do nothing. `pass`: fall through untouched. */
export type ClearScreenAction = 'clear' | 'swallow' | 'pass';

export function clearScreenAction(target: ClearScreenTarget | null, macLike: boolean): ClearScreenAction {
    if (target === null) return 'pass';
    // A renderer that cannot say leaves it to the daemon, which checks the screen again.
    if (target.alternateScreen?.() !== true) return 'clear';
    if (!macLike || target.kittyKeyboardActive?.() === true) return 'pass';
    return 'swallow';
}

export interface ClearScreenDeps {
    readonly focusedPaneID: () => string | null;
    /** The pane's live renderer read, or null when it has no terminal renderer. */
    readonly screenFor: (paneID: string) => ClearScreenTarget | null;
    /** Whether the platform's primary modifier is ⌘ (`chrome/keys.ts` `CLIENT_MAC_LIKE`). */
    readonly macLike: boolean;
    /** Ask the daemon to clear the pane. Fire and forget: the chord is already consumed. */
    readonly clear: (paneID: string) => void;
}

/** True when the chord is consumed, false to fall through (docs/config-keybindings.md 7.2). */
export function clearFocusedScreen(deps: ClearScreenDeps): boolean {
    const paneID = deps.focusedPaneID();
    if (paneID === null) return false;
    const action = clearScreenAction(deps.screenFor(paneID), deps.macLike);
    if (action === 'clear') deps.clear(paneID);
    return action !== 'pass';
}
