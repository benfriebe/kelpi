/**
 * N14 — the renderer half of File ▸ Close (⌘W).
 *
 * `KeyBinding.swift:285-296` deliberately keeps `close_pane` out of `isMenuBarAction`, so the
 * shipped app has **no ⌘W menu item at all** and its `NSEvent` monitor always gets the chord
 * first, whatever holds first responder — a `WKWebView` preview included. The port could not
 * copy that shape literally: a macOS app with no Close item and no ⌘W is wrong for the platform,
 * and Electron's `role: 'close'` closes the WINDOW, which is the escape N14 is about (a ⌘W with
 * focus inside a content pane's cross-origin frame took the whole window with it).
 *
 * So the row stays, its accelerator stays visible, and its click **asks the page first**: the
 * shell evaluates `window[SHELL_CLOSE_GLOBAL]()` in the focused window and only closes the
 * window when the page answers "nothing here to close" or does not answer at all. This module is
 * what that global lands on.
 *
 * Two properties matter, and both are why it is a module rather than three lines in `App.tsx`:
 *
 *   1. **It is the keys.ts path, not a second one.** `request()` replays a real ⌘W keydown
 *      through the very dispatcher a keystroke goes through (`replayChordCommand`), so the
 *      palette guard, the active-workspace guard, the web-pane priority layer and the
 *      `close_pane` handler's own "is there anything to close" answer all apply unchanged. The
 *      menu row and the chord cannot drift, because they are the same code.
 *   2. **A ⌘W must never close two panes.** Whether a native menu accelerator can still fire
 *      after a cross-origin frame `preventDefault`s the same keystroke is not observable from
 *      inside the app (it is a Chromium/AppKit redispatch detail), so this side is written to be
 *      correct either way: a request that lands within `coalesceMs` of a close the KEYBOARD path
 *      already performed is answered "handled" without closing a second pane.
 */

/** The name the shell evaluates in the focused window (`shell/src/menu.ts`). Pinned in both suites. */
export const SHELL_CLOSE_GLOBAL = '__kelpiShellClosePane';

/**
 * How long a keyboard close silences a menu-routed one.
 *
 * Long enough to cover a redispatch that goes out to the main process and back (a menu click is
 * one turn of the event loop plus an IPC round trip), short enough that a user pressing ⌘W twice
 * in a row still closes two panes — the fastest deliberate repeat is a key-repeat, ~500 ms after
 * the first press on the default macOS delay.
 */
export const KEYBOARD_CLOSE_COALESCE_MS = 400;

/** The chord the shell's Close row stands for, in `replayChordCommand`'s vocabulary. */
export const CLOSE_PANE_CHORD_COMMAND = 'web-chord:KeyW';

export interface ShellCloseBridge {
    /**
     * The shell's Close row was clicked (or its accelerator fired). Returns true when the page
     * dealt with it — the shell then leaves the window alone.
     */
    request(): boolean;
    /**
     * The dispatcher just closed something for a REAL ⌘W. Called from the `close_pane` key
     * action; a replay this bridge itself started is ignored, so a menu-routed close is never
     * mistaken for the keyboard one it is standing in for.
     */
    noteKeyboardClose(): void;
}

export interface ShellCloseBridgeOptions {
    /** `replayChordCommand(CLOSE_PANE_CHORD_COMMAND)` — true when the dispatcher consumed it. */
    readonly replay: () => boolean;
    readonly now?: (() => number) | undefined;
    readonly coalesceMs?: number | undefined;
}

export function createShellCloseBridge(options: ShellCloseBridgeOptions): ShellCloseBridge {
    const now = options.now ?? (() => Date.now());
    const coalesceMs = options.coalesceMs ?? KEYBOARD_CLOSE_COALESCE_MS;
    /** When the keyboard path last closed a pane; -Infinity = never. */
    let lastKeyboardClose = Number.NEGATIVE_INFINITY;
    /** True only for the synchronous span of our own replay. */
    let replaying = false;

    return {
        request(): boolean {
            if (now() - lastKeyboardClose < coalesceMs) return true;
            replaying = true;
            try {
                return options.replay();
            } finally {
                replaying = false;
            }
        },
        noteKeyboardClose(): void {
            if (replaying) return;
            lastKeyboardClose = now();
        }
    };
}

/** The `window` surface this module writes to (narrowed so a test can hand it a plain object). */
export interface ShellCloseGlobalTarget {
    [key: string]: unknown;
}

/**
 * Publish `request` as the global the shell evaluates, and return the disposer.
 *
 * Only meaningful inside the Electron window — a browser tab has no menu bar to route from — but
 * harmless there, which is why it is installed unconditionally rather than behind a
 * `shellWindowID` test that would go wrong the first time the client is opened in a browser
 * beside a desktop window.
 */
export function installShellCloseBridge(
    bridge: ShellCloseBridge,
    target?: ShellCloseGlobalTarget | undefined
): () => void {
    const host = target ?? (globalThis as unknown as ShellCloseGlobalTarget | undefined);
    if (host === undefined) return () => undefined;
    const previous = host[SHELL_CLOSE_GLOBAL];
    host[SHELL_CLOSE_GLOBAL] = (): boolean => bridge.request();
    return () => {
        if (previous === undefined) delete host[SHELL_CLOSE_GLOBAL];
        else host[SHELL_CLOSE_GLOBAL] = previous;
    };
}
