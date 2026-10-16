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

import type { DroppedFilesResolution } from './dropped-files';
import { resolvedDropOutcome } from './open-file';

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
    readonly selectionFor: (paneID: string) => string | null | Promise<string>;
    /** The system clipboard write, or null when this browser exposes none. */
    readonly writeText: ((text: string) => Promise<void>) | null;
    /** Start a clipboard write now while an opaque renderer resolves its selected text. */
    readonly writePendingText?: ((text: Promise<string>) => Promise<void>) | undefined;
    /** Surfaced as the app's usual error toast. Never the copied text, only the reason. */
    readonly onError: (detail: string) => void;
}

/** A promised ClipboardItem checks activation when copy starts, before a renderer replies. */
export function deferredClipboardWriter(
    clipboard: Pick<Clipboard, 'write'> | undefined,
    Item: typeof ClipboardItem | undefined = globalThis.ClipboardItem
): ((text: Promise<string>) => Promise<void>) | undefined {
    if (typeof clipboard?.write !== 'function' || typeof Item !== 'function') return undefined;
    return text => {
        const data = text.then(value => new Blob([value], { type: 'text/plain' }));
        // Permission rejection or construction failure can happen before the browser reads
        // this representation. Keep a later empty-selection rejection handled in that case.
        void data.catch(() => {});
        return clipboard.write([new Item({ 'text/plain': data })]);
    };
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
    if (typeof selection !== 'string') {
        // The frame is opaque: ask its live renderer. Capture the pane now so a delayed reply
        // cannot copy a newly focused pane, and never send a terminal interrupt for no selection.
        if (deps.writePendingText) {
            const empty = new Error('No terminal selection.');
            const text = selection.then(value => { if (!value) throw empty; return value; });
            void text.catch(() => {});
            let writing: Promise<void>;
            try { writing = deps.writePendingText(text); }
            catch (error) { writing = Promise.reject(error); }
            // An empty representation rejects the write, preserving the existing clipboard.
            // Wait for the selection even if permission fails first, so no selection remains
            // a quiet no-op and actual renderer/write errors are reported once.
            void Promise.allSettled([text, writing]).then(([selected, written]) => {
                const failure = selected.status === 'rejected' ? selected : written.status === 'rejected' ? written : null;
                if (failure && failure.reason !== empty) deps.onError(failure.reason instanceof Error ? failure.reason.message : String(failure.reason));
            });
            return true;
        }
        void selection.then(async text => {
            if (!text) return;
            if (!deps.writeText) throw new Error('this browser exposes no clipboard');
            await deps.writeText(text);
        }).catch((error: unknown) => deps.onError(error instanceof Error ? error.message : String(error)));
        return true;
    }
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

/**
 * #382: what a paste found on the clipboard, in terminal-surface.md section 12.2's order.
 *
 * - `text`: a non-empty string, for the daemon's paste pipeline (`drop-text`);
 * - `image`: no text but a PNG, for TERM-043's upload route (`paste-image`);
 * - `paths`: no text and no PNG the page can see, but files on the pasteboard (CleanShot's Copy,
 *   or any copy that puts a file link and no text there), which the window's shell read. `text` is what a drop of the same
 *   files types, or null when none could be typed, and `notice` says what was left out;
 * - `nothing`: none of those, with the sentence to show. Never silent for ⌘V: a dead paste
 *   chord with no explanation is what #382 reported.
 */
export type ClipboardPaste =
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'image'; readonly image: Blob }
    | { readonly kind: 'paths'; readonly text: string | null; readonly notice: string | null }
    | { readonly kind: 'nothing'; readonly notice: string };

export interface ClipboardPasteSources {
    readonly clipboard: Clipboard | undefined;
    /**
     * Ask this window's shell for the files on the pasteboard (`app/dropped-files.ts` ▸
     * `resolveClipboard`), or null where there is no shell to ask (a browser).
     */
    readonly readFiles: (() => Promise<DroppedFilesResolution>) | null;
}

/** ⌘V over a clipboard holding nothing a terminal can take. */
export const NOTHING_TO_PASTE_NOTICE = 'the clipboard holds no text, image or file to paste';

/** #382: a browser cannot learn where a copied file lives, as it cannot for a dropped one. */
export const BROWSER_CLIPBOARD_FILE_NOTICE =
    'a browser does not reveal where a copied file lives, so there is no path to paste; ' +
    'paste it in the Kelpi desktop app, or type the path';

/**
 * Read the clipboard for a paste into a terminal, the one copy of section 12.2's order that ⌘V
 * in this window (`App.tsx` ▸ `pasteClipboardInto`) and ⌘V or middle-click in a remote host's or
 * a plugin's pane (`app/terminal-shortcuts.tsx` ▸ `pasteIntoOwner`) both run.
 *
 * Throws when there is no clipboard API at all or `readText` is refused: the caller reports it.
 * Everything after that resolves. A `read()` that throws or finds no PNG goes on to the shell
 * rather than giving up, because a pasteboard holding a file link is exactly the one the page's
 * `read()` cannot describe (one item, `types: []`, measured on Electron 43: Chromium hides the
 * image beside a file link, since a Finder Copy's image is the file's icon).
 */
export async function readClipboardForPaste(sources: ClipboardPasteSources): Promise<ClipboardPaste> {
    const clipboard = sources.clipboard;
    if (clipboard === undefined || typeof clipboard.readText !== 'function') throw new Error('this browser exposes no clipboard');
    const text = await clipboard.readText();
    if (text !== '') return { kind: 'text', text };
    // An item the page can see but not read is the signature of a file on the pasteboard.
    let opaqueItem = false;
    if (typeof clipboard.read === 'function') {
        try {
            for (const item of await clipboard.read()) {
                if (item.types.includes('image/png')) return { kind: 'image', image: await item.getType('image/png') };
                if (item.types.length === 0) opaqueItem = true;
            }
        } catch {
            // The page could not tell what is there, so a reason the shell gives below is worth
            // showing: it may be the only explanation for a clipboard that is not empty.
            opaqueItem = true;
        }
    }
    if (sources.readFiles === null) return { kind: 'nothing', notice: opaqueItem ? BROWSER_CLIPBOARD_FILE_NOTICE : NOTHING_TO_PASTE_NOTICE };
    const files = await sources.readFiles();
    if (files.paths.length === 0 && files.unresolved === 0) {
        // The shell's or daemon's reason (an older shell, a timeout) matters only when there was
        // something to read; over a plainly empty clipboard it would only confuse.
        return { kind: 'nothing', notice: files.error !== null && opaqueItem ? files.error : NOTHING_TO_PASTE_NOTICE };
    }
    return { kind: 'paths', ...resolvedDropOutcome(files, 'copied') };
}
