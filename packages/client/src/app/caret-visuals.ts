/**
 * The two terms the focus RING was missing (issue #174).
 *
 * ghostty computes a surface's focus as `window.isKeyWindow && … && isFirstResponder`
 * (`BaseTerminalController.syncFocusToSurfaceTree`). The port had all three inputs somewhere and
 * the ring read none of them: `grid/FocusRing.tsx` was drawn from `focusedPaneID` alone, so a
 * backgrounded Kelpi window showed a full-strength blue border, and so did a window whose caret
 * was in the sidebar rename field. The cursor had the window term already
 * (`terminal/TerminalPane.tsx`, §N20) and nothing had the responder term.
 *
 * Both are facts about the WINDOW rather than about any one pane, so they are ONE store here
 * with the hooks reading it through `useSyncExternalStore`, not a copy of the listeners per
 * subscriber: the grid reads them for the ring and every mounted `TerminalPane` reads them for
 * `surfaceFocused` (which is what hollows the cursor), so a window with eight terminals would
 * otherwise carry nine `focusin` listeners answering the same question nine times per keystroke
 * into a rename field. The listeners go on with the first subscriber and come off with the last.
 *
 * `focusedPaneID` is untouched by either term. A workspace always has a focused pane, and
 * `docs/shell-ui.md` §4.1 says the ring marks it; these say whether the keyboard is with that
 * pane right now.
 */

import { useSyncExternalStore } from 'react';

import { chromeCaretHeld } from './pane-focus';

// ── the window's key state ──────────────────────────────────────────────────────────

const windowSubscribers = new Set<() => void>();
/** null until first read: the cache is seeded lazily and kept current while anyone listens. */
let windowFocused: boolean | null = null;
let windowListening = false;

function measureWindowFocused(): boolean {
    return typeof document === 'undefined' ? true : document.hasFocus();
}

function setWindowFocused(next: boolean): void {
    if (windowFocused === next) return;
    windowFocused = next;
    for (const notify of [...windowSubscribers]) notify();
}

const onWindowFocus = (): void => setWindowFocused(true);
const onWindowBlur = (): void => setWindowFocused(false);

function readWindowFocused(): boolean {
    windowFocused ??= measureWindowFocused();
    return windowFocused;
}

function subscribeWindowFocused(notify: () => void): () => void {
    windowSubscribers.add(notify);
    if (!windowListening && typeof window !== 'undefined') {
        window.addEventListener('focus', onWindowFocus);
        window.addEventListener('blur', onWindowBlur);
        windowListening = true;
        // Re-seed: nothing was watching until now, so the cache may predate an alt-tab.
        setWindowFocused(measureWindowFocused());
    }
    return (): void => {
        windowSubscribers.delete(notify);
        if (windowSubscribers.size > 0 || !windowListening) return;
        window.removeEventListener('focus', onWindowFocus);
        window.removeEventListener('blur', onWindowBlur);
        windowListening = false;
    };
}

/**
 * The browser's `isKeyWindow`.
 *
 * Seeded from `document.hasFocus()` rather than from `true`, because a pane can mount into a
 * window that is already in the background (a reload behind another app, a restored session).
 *
 * Not the whole answer for a WEB pane: its page is a native `WebContentsView` composited over
 * this document, and the shell has measured that `document.hasFocus()` reads false once a pane
 * finishes loading (`packages/shell/src/webhost/view-focus.ts`). A focused web pane therefore
 * has the keyboard while this reads false, which is why `grid/PaneGrid.tsx` subtracts that case
 * before dimming the ring. For a TERMINAL the unqualified answer is the right one: when the
 * view has the keys, no terminal surface does.
 */
export function useWindowFocused(): boolean {
    return useSyncExternalStore(subscribeWindowFocused, readWindowFocused, () => true);
}

// ── `isFirstResponder`, inverted ────────────────────────────────────────────────────

const caretSubscribers = new Set<() => void>();
let chromeCaret: boolean | null = null;
let caretListening = false;
let deferredDecide: ReturnType<typeof setTimeout> | null = null;
/**
 * The element {@link chromeCaretHeld} last said yes about.
 *
 * Kept because a focused element that is REMOVED from the document dispatches no `focusout`
 * and no `blur` in any engine (measured in this repo's jsdom too), so the event pair alone
 * cannot notice the sidebar rename committing on Enter: `InlineEditor`'s commit unmounts the
 * input it is focused in, and without this the answer stuck on "a chrome field has the caret"
 * until something unrelated took focus, leaving the focused pane with a dimmed ring and a
 * hollow cursor indefinitely. That is issue #174 with the sign flipped.
 */
let caretHolder: Element | null = null;
let removalWatch: MutationObserver | null = null;

/** Who holds the caret if it is chrome, `null` if it is a pane surface, nobody, or gone. */
function measureCaretHolder(): Element | null {
    if (typeof document === 'undefined') return null;
    if (!chromeCaretHeld()) return null;
    const active = document.activeElement;
    // A holder that has left the document is not holding anything, whatever `activeElement`
    // still reports: this is the removal case above, read rather than waited for.
    if (active === null || !active.isConnected) return null;
    return active;
}

/** Cheap because it early-returns on every mutation that did not take the holder away. */
const onDomMutation = (): void => {
    if (caretHolder !== null && caretHolder.isConnected) return;
    refreshChromeCaret();
};

function armRemovalWatch(): void {
    if (removalWatch !== null || typeof MutationObserver === 'undefined') return;
    removalWatch = new MutationObserver(onDomMutation);
    removalWatch.observe(document, { childList: true, subtree: true });
}

function disarmRemovalWatch(): void {
    removalWatch?.disconnect();
    removalWatch = null;
}

function refreshChromeCaret(): void {
    caretHolder = measureCaretHolder();
    // Armed only while a chrome field actually holds the caret, which is a rename or a palette
    // session and nothing else: the observer is off for the whole of ordinary typing.
    if (caretHolder === null) disarmRemovalWatch();
    else armRemovalWatch();
    const next = caretHolder !== null;
    if (chromeCaret === next) return;
    chromeCaret = next;
    for (const notify of [...caretSubscribers]) notify();
}

const onCaretFocusIn = (): void => {
    refreshChromeCaret();
};

/**
 * `focusout` is dispatched with `activeElement` already dropped to `<body>`, before the element
 * gaining focus is dispatched its `focusin`, so reading it there would report "no chrome field"
 * for one tick during every ordinary move between two chrome fields and flash the ring back to
 * full strength. The answer is therefore taken one task later, which is also what answers
 * Escape in the sidebar filter (a blur with nothing taking the caret). `focusin` still settles
 * the common case synchronously.
 *
 * This pair is not a complete account of caret ownership on its own, which is what
 * {@link caretHolder} and the removal watch are for.
 */
const onCaretFocusOut = (): void => {
    if (deferredDecide !== null) return;
    deferredDecide = setTimeout(() => {
        deferredDecide = null;
        refreshChromeCaret();
    }, 0);
};

function readChromeCaret(): boolean {
    chromeCaret ??= measureCaretHolder() !== null;
    return chromeCaret;
}

function subscribeChromeCaret(notify: () => void): () => void {
    caretSubscribers.add(notify);
    if (!caretListening && typeof document !== 'undefined') {
        // Capture phase, for the reason `armCaretClaim` uses it: a chrome field that stops
        // propagation of its own focus events must not be able to strand the answer.
        document.addEventListener('focusin', onCaretFocusIn, true);
        document.addEventListener('focusout', onCaretFocusOut, true);
        caretListening = true;
        refreshChromeCaret();
    }
    return (): void => {
        caretSubscribers.delete(notify);
        if (caretSubscribers.size > 0 || !caretListening) return;
        document.removeEventListener('focusin', onCaretFocusIn, true);
        document.removeEventListener('focusout', onCaretFocusOut, true);
        caretListening = false;
        if (deferredDecide !== null) {
            clearTimeout(deferredDecide);
            deferredDecide = null;
        }
        disarmRemovalWatch();
        caretHolder = null;
    };
}

/** True while a chrome text field owns the caret, so the ringed pane is not the keyboard's. */
export function useChromeCaret(): boolean {
    return useSyncExternalStore(subscribeChromeCaret, readChromeCaret, () => false);
}
