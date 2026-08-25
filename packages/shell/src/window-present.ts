/**
 * N15 — putting the window in front of the user, once, for every gesture that asks.
 *
 * The defect this exists for: a window closed and then reopened from the Dock came up **without
 * keyboard focus**. It rendered, but keystrokes kept going to whatever had them before and no
 * click inside it took them back. The cause is a two-branch `showWindow` that had grown apart:
 * the branch for a window that already exists did `show()` → `focus()` → `app.focus({steal})`,
 * while both branches that BUILD a window did a bare `show()`. A shown window is not a key
 * window, and a key window whose web contents never took focus still types nowhere — so the
 * recreate path (`app.on('activate')` with no windows, and `showWindow()` after a close) skipped
 * exactly the two calls that make a window typable.
 *
 * The Swift app never had the problem because it never rebuilds anything: `showWindow()` there
 * is `NSApp.activate` on a window that has existed since launch. Here the window is genuinely
 * new, so the handoff has to be performed rather than inherited — and it has to be performed
 * identically however the window came to be, which is what this module is.
 *
 * Pure of Electron (the window is a structural type), so `window-present.test.ts` can drive
 * every branch with a recording double — the same reason `menu.ts` exists.
 */

/** The slice of `BrowserWindow` this module touches. */
export interface PresentableWindow {
    isDestroyed(): boolean;
    isMinimized(): boolean;
    restore(): void;
    show(): void;
    focus(): void;
    readonly webContents?: PresentableWebContents | undefined;
}

export interface PresentableWebContents {
    isDestroyed?(): boolean;
    focus(): void;
}

export interface PresentWindowDeps<W extends PresentableWindow> {
    /** The window as it stands: null (never built) and destroyed (closed) both mean "build one". */
    readonly current: W | null;
    /** Builds a window. Only called when there is nothing usable to raise. */
    readonly create: () => W;
    /** `process.platform`; only darwin gets the app-level activation below. */
    readonly platform: string;
    /**
     * `app.focus({ steal: true })`.
     *
     * On macOS a window `focus()` inside an app that is not frontmost does not make the app
     * frontmost, and the Dock-click case is exactly that: the app is activating around the same
     * moment the window is built. Without this the window can end up visible, key *within* the
     * app, and still not receiving keystrokes.
     */
    readonly appFocus?: (() => void) | undefined;
}

export interface PresentWindowResult<W extends PresentableWindow> {
    readonly window: W;
    /** True when this call built the window (the N15 path). */
    readonly created: boolean;
    /** True when a minimized window was restored on the way up. */
    readonly restored: boolean;
    /** True when the page's own widget was given focus (false only if it is already gone). */
    readonly focusedContents: boolean;
}

/**
 * Raise, focus and hand keyboard focus to the window — building one first if there is none.
 *
 * The order matters and is the order AppKit wants: restore before show (a minimized window
 * cannot take focus), show before focus (an invisible window cannot become key), window focus
 * before contents focus (the widget's focus is scoped to its window), and the app-level
 * activation last, because it is the only step that can be refused by the OS and everything
 * before it stays true regardless.
 */
export function presentWindow<W extends PresentableWindow>(
    deps: PresentWindowDeps<W>
): PresentWindowResult<W> {
    const existing = deps.current !== null && !deps.current.isDestroyed() ? deps.current : null;
    const window = existing ?? deps.create();
    const created = existing === null;

    let restored = false;
    if (!created && window.isMinimized()) {
        window.restore();
        restored = true;
    }
    window.show();
    window.focus();
    const focusedContents = focusWindowContents(window);
    if (deps.platform === 'darwin') deps.appFocus?.();

    return { window, created, restored, focusedContents };
}

/**
 * Give the page inside a window the keyboard.
 *
 * Split out because the window's *first paint* needs it too: a freshly built window is shown
 * from `ready-to-show`, after `presentWindow` has already returned, and a `focus()` taken before
 * there was anything to focus does not survive to the page. Returns false when the contents are
 * gone (a window mid-teardown), which is a no-op rather than a throw.
 */
export function focusWindowContents(window: PresentableWindow): boolean {
    const contents = window.webContents;
    if (contents === undefined || contents === null) return false;
    if (contents.isDestroyed?.() === true) return false;
    contents.focus();
    return true;
}

/**
 * The line `main.ts` logs, and the only trace of the handoff visible from outside the process —
 * `scripts/smoke.mjs` asserts on it, because "the window can be typed into" is not otherwise
 * observable without a keyboard and a human.
 */
export function presentWindowLogLine(result: PresentWindowResult<PresentableWindow>): string {
    const parts = [result.created ? 'created' : 'raised'];
    if (result.restored) parts.push('restored');
    parts.push('focused');
    if (result.focusedContents) parts.push('contents-focused');
    return `window: presented (${parts.join(', ')})`;
}
