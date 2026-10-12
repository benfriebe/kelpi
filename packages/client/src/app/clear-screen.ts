/**
 * ⌘K: clear the focused terminal pane's screen and scrollback.
 *
 * Spec: docs/config-keybindings.md section 4 (category "Terminal"), docs/terminal-surface.md
 * section 10.4.
 *
 * ## Why this is an action at all
 *
 * Ghostty binds `super+k` to `clear_screen` on macOS (`src/config/Config.zig`, the darwin branch
 * of `Keybinds.init`), and the pre-port app inherited that binding from libghostty without ever
 * naming it. This client carries its own binding table, the table had no such row, and an
 * unbound ⌘ chord is just a keystroke: the legacy encoder drops super, so ⌘K typed a `k` at the
 * prompt and cleared nothing.
 *
 * ## Why it asks the daemon instead of clearing the engine in this window
 *
 * The history a user means by "scrollback" is the daemon's (`@xterm/headless`): it is what a
 * re-attach replays, what `pane capture` reads and what a handoff checkpoints. Wiping this
 * window's engine alone would look right until the next workspace switch replayed everything
 * back. So the chord is a command (`clear-screen`), the daemon clears its buffer and re-seeds
 * every client attached to the pane, and this window is cleared by that replay like any other.
 */

/** What `clearFocusedScreen` needs. */
export interface ClearScreenDeps {
    readonly focusedPaneID: () => string | null;
    /** True when this pane has a live terminal renderer (the same test `copy` and `paste` use). */
    readonly isTerminalPane: (paneID: string) => boolean;
    /** Sends `clear-screen` for the pane and reports a failure. Not awaited. */
    readonly clear: (paneID: string) => void;
}

/**
 * Returns true when the chord is consumed, false to fall through (docs/config-keybindings.md
 * section 7.2 step 7): a markdown pane, a diff pane and a web pane keep whatever ⌘K means to them.
 */
export function clearFocusedScreen(deps: ClearScreenDeps): boolean {
    const paneID = deps.focusedPaneID();
    if (paneID === null) return false;
    if (!deps.isTerminalPane(paneID)) return false;
    deps.clear(paneID);
    return true;
}
