/**
 * ⌘K: clear a terminal pane's screen and scrollback (`pane-clear`), Ghostty's `clear_screen`.
 *
 * ## Why in the output stream
 *
 * A pane's screen exists in several places at once: the daemon's headless emulator (what
 * `pane capture`, a reattach snapshot and a handoff checkpoint read), and one engine per
 * attached client, any of which may be another window, a browser or a phone. Clearing one of
 * them clears nothing that matters: the next reattach would bring the scrollback back, and every
 * other viewer would keep it. So the clear is a few VT sequences put into the pane's OUTPUT
 * (`KelpiPtyManager.injectOutput`), at one point in the stream every copy parses in the same
 * order. Every engine then performs the same erase on the same state.
 *
 * ## What it sends, after Ghostty
 *
 * `src/termio/Termio.zig` `clearScreen(history: true)`, case by case:
 *
 * - **Alternate screen**: nothing at all. "Since this is an emulator-level screen clear, this
 *   messes up the running programs knowledge of where the cursor is." The chord is not consumed
 *   (Ghostty's `Surface.zig` returns false for it), so it reaches the app.
 * - **At a prompt**: erase the scrollback and the whole screen, then send the shell a form feed
 *   (`0x0c`) "so that it can repaint the screen". zle, readline and fish all redraw the prompt
 *   and the line being edited at the top. Ghostty knows it is at a prompt from OSC 133 marks;
 *   Kelpi asks the kernel instead (`pty/shell-foreground.ts`).
 * - **Otherwise**: erase the scrollback and REMOVE the rows above the cursor's. Ghostty's
 *   `Screen.eraseActive` physically deletes them (`PageList.eraseRows`, then `cursorReload`), so
 *   the cursor's row becomes the top row, everything under it moves up with it, and the cursor
 *   moves with its row. What a running program drew on and below its cursor row (an agent's
 *   input box, a progress line) is kept, just higher up.
 *
 * The "otherwise" removal is a scroll up by the cursor's row (SU), which deletes that many rows
 * from the top and adds blank ones at the bottom, then a cursor up by the same count (CUU), so
 * the cursor follows its row. Neither touches the application's saved cursor (DECSC), which a
 * restore-from-saved approach would overwrite. Two costs, both shared with every other way of
 * spelling it in-stream: a pending autowrap (a cursor parked past the last column) is dropped,
 * and SU honours a scroll region (DECSTBM) where Ghostty's erase does not. A program that set
 * one on the normal screen loses the rows above the cursor inside its region rather than across
 * the whole screen.
 */

import type { ScreenCursor } from './service.js';

/** ED 3: erase the scrollback. */
const ERASE_SCROLLBACK = '\x1b[3J';
/** CUP home, then ED 2: the whole visible screen. */
const ERASE_SCREEN = '\x1b[H\x1b[2J';
/** ⌃L, what a line editor redraws its prompt on. */
export const FORM_FEED = '\x0c';

/**
 * The bytes that clear the screen from `cursor`'s state, or null when nothing may be cleared
 * (the alternate screen).
 *
 * At a prompt the screen goes before the scrollback, so a screen an emulator chooses to push
 * into history on ED 2 is still erased by the ED 3 that follows.
 */
export function clearScreenSequence(cursor: ScreenCursor, atPrompt: boolean): string | null {
    if (cursor.alternate) return null;
    if (atPrompt) return ERASE_SCREEN + ERASE_SCROLLBACK;
    const row = Math.max(0, Math.floor(cursor.row));
    if (row === 0) return ERASE_SCROLLBACK;
    // SU drops the `row` rows above the cursor's; CUU takes the cursor up with its row. The
    // scrollback goes last, so anything an emulator chose to keep from the SU goes with it.
    return `\x1b[${String(row)}S\x1b[${String(row)}A${ERASE_SCROLLBACK}`;
}

export type ScreenClearOutcome =
    | { readonly cleared: true }
    | { readonly cleared: false; readonly reason: 'alternate-screen' | 'no-terminal' };

export interface ScreenClearerDeps {
    /** Await every byte fed to the pane's emulator so far. */
    readonly flush: (paneID: string) => Promise<void>;
    /** The emulator's active screen and cursor; null when the pane has no terminal state. */
    readonly screenCursor: (paneID: string) => ScreenCursor | null;
    /** The pane's interactive shell's pid, or undefined when it should not be asked about. */
    readonly shellPid: (paneID: string) => number | undefined;
    /** Whether that shell is at its prompt (`pty/shell-foreground.ts`). */
    readonly shellAtPrompt: (pid: number) => Promise<boolean>;
    /** Into the pane's output stream (`KelpiPtyManager.injectOutput`). */
    readonly injectOutput: (paneID: string, data: string) => void;
    /** To the pane's process alone, never a synchronised-input sibling (`writeDirect`). */
    readonly writeInput: (paneID: string, data: string) => void;
}

export type ScreenClearer = (paneID: string) => Promise<ScreenClearOutcome>;

/**
 * Clear a pane, deciding from the state its emulator has parsed.
 *
 * The prompt probe runs FIRST, because it waits on the OS; the flush, the cursor read and the
 * injection then happen with no await between the last two, so no output can be parsed in
 * between and the cursor the sequence restores is the cursor the stream has at that point.
 */
export function createScreenClearer(deps: ScreenClearerDeps): ScreenClearer {
    return async (paneID) => {
        const pid = deps.shellPid(paneID);
        const atPrompt = pid === undefined ? false : await deps.shellAtPrompt(pid);
        await deps.flush(paneID);
        const cursor = deps.screenCursor(paneID);
        if (cursor === null) return { cleared: false, reason: 'no-terminal' };
        const sequence = clearScreenSequence(cursor, atPrompt);
        if (sequence === null) return { cleared: false, reason: 'alternate-screen' };
        deps.injectOutput(paneID, sequence);
        if (atPrompt) deps.writeInput(paneID, FORM_FEED);
        return { cleared: true };
    };
}
