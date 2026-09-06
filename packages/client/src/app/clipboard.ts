/**
 * The `copy` and `paste` actions' decisions (#81), lifted out of `App.tsx` so they can be
 * asserted without a window.
 *
 * Spec: docs/terminal-surface.md section 12.1 (copy) and 12.2 (paste), docs/config-keybindings.md
 * section 4.
 *
 * ## What the user reported
 *
 * "I can't copy text from a terminal session and paste into another one (but sometimes I can?)".
 * The "sometimes" was copy-on-select: the engine copies on mouse-up
 * (`vendor/ghostty-web-patched/source/lib/selection-manager.ts:543-547`) and that was the ONLY
 * copy path in the app. `SelectionManager` registers no `keydown` and no `copy` listener
 * (`:420-661`), and the engine's own comment claiming otherwise (`input-handler.ts:382-386`,
 * "SelectionManager handles the actual copying") is simply wrong. So ⌘C fell to the shell's
 * `{ role: 'editMenu' }` Copy, which copied the hidden textarea's DOM selection. That is empty,
 * the clipboard kept whatever it held, and the next ⌘V pasted the OLD text.
 *
 * ## The two rules that shape both functions
 *
 * **Decline, never swallow.** A handler returning `false` is the dispatcher's fall-through
 * (`chrome/keys.ts` step 7): the keystroke is not consumed and reaches whatever is next. That is
 * what keeps ⌘C and ⌘V meaning the Edit menu's Copy and Paste everywhere that is not a terminal
 * pane, with no pane-type table here: `selectionFor` returns `null` for a pane with no live
 * terminal renderer, which covers markdown, diff, web, the scratchpad, and a terminal whose
 * engine has not opened yet.
 *
 * **An empty selection is a decline, not a SIGINT.** #81 suggested falling through to `0x03`.
 * It is not safe: mouse reporting clears the selection on every press (ghostty's own rule,
 * `Surface.zig:3850-3852`, mirrored in `TerminalPane.tsx`), so inside an agent pane the selection
 * is empty far more often than not, and a ⌘C that sometimes sends an interrupt would kill the
 * agent the user was trying to copy from. ⌃C is the interrupt and is untouched. Falling through
 * types nothing, because the engine returns from its `keydown` handler for ⌘C without encoding
 * it, which is also exactly what macOS does with ⌘C and no selection.
 */

/** What `copySelection` needs. Every field is a seam the app fills from live state. */
export interface CopySelectionDeps {
    /** The focused pane, or null when nothing is focused. */
    readonly focusedPaneID: () => string | null;
    /**
     * That pane's LIVE selection, or `null` when it has no terminal renderer at all.
     *
     * `null` and `''` are deliberately different answers: `null` means "not my chord", `''`
     * means "mine, and there is nothing to copy". Both decline; only the second is a terminal.
     */
    readonly selectionFor: (paneID: string) => string | null;
    /** The system clipboard write, or null when this browser exposes none. */
    readonly writeText: ((text: string) => Promise<void>) | null;
    /** Surfaced as the app's usual error toast. Never the copied text, only the reason. */
    readonly onError: (detail: string) => void;
}

/**
 * ⌘C: put the focused terminal pane's selection on this machine's clipboard.
 *
 * Returns true when the chord is consumed. The write is fired and not awaited, because the
 * dispatcher is synchronous; a rejected write is reported rather than retried.
 */
export function copySelection(deps: CopySelectionDeps): boolean {
    const paneID = deps.focusedPaneID();
    if (paneID === null) return false;
    const selection = deps.selectionFor(paneID);
    if (selection === null) return false;
    if (selection === '') return false;
    if (deps.writeText === null) {
        // Consumed: this IS a terminal pane with a selection, so falling through to a copy that
        // cannot work either would only make the failure silent.
        deps.onError('this browser exposes no clipboard');
        return true;
    }
    void deps.writeText(selection).catch((error: unknown) => {
        deps.onError(error instanceof Error ? error.message : String(error));
    });
    return true;
}

/** What `pasteIntoFocusedPane` needs. */
export interface PasteDeps {
    readonly focusedPaneID: () => string | null;
    /** True when this pane has a live terminal renderer (the same test `copy` uses). */
    readonly isTerminalPane: (paneID: string) => boolean;
    /** Runs section 12.2's resolution order against the real clipboard. Not awaited. */
    readonly deliver: (paneID: string) => Promise<void>;
}

/**
 * ⌘V: paste into the FOCUSED pane, rather than into whatever DOM node holds the caret.
 *
 * That difference is the point. The Edit menu role's Paste targets the caret, so it lands in the
 * pane only while the engine's hidden textarea has it (the other half of #35). Resolving against
 * the focused pane makes it land in the pane the user is looking at, every time.
 */
export function pasteIntoFocusedPane(deps: PasteDeps): boolean {
    const paneID = deps.focusedPaneID();
    if (paneID === null) return false;
    if (!deps.isTerminalPane(paneID)) return false;
    void deps.deliver(paneID);
    return true;
}
