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
 * Both are facts about the WINDOW rather than about any one pane, so they are hooks here instead
 * of a second copy in each consumer: the grid reads them once for the ring, and `TerminalPane`
 * reads them for `surfaceFocused` (which is what hollows the cursor). `focusedPaneID` is
 * untouched by either - a workspace always has a focused pane, and `docs/shell-ui.md` §4.1 says
 * the ring marks it. These say whether the keyboard is with that pane right now.
 */

import { useEffect, useState } from 'react';

import { chromeCaretHeld } from './pane-focus';

/**
 * The browser's `isKeyWindow`.
 *
 * Seeded from `document.hasFocus()` rather than from `true`, because a pane can mount into a
 * window that is already in the background (a reload behind another app, a restored session),
 * and re-seeded inside the effect because the window may have lost focus between the initial
 * state and the listeners going on.
 */
export function useWindowFocused(): boolean {
    const [focused, setFocused] = useState<boolean>(() =>
        typeof document === 'undefined' ? true : document.hasFocus()
    );
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const gained = (): void => setFocused(true);
        const lost = (): void => setFocused(false);
        window.addEventListener('focus', gained);
        window.addEventListener('blur', lost);
        setFocused(document.hasFocus());
        return () => {
            window.removeEventListener('focus', gained);
            window.removeEventListener('blur', lost);
        };
    }, []);
    return focused;
}

/**
 * `isFirstResponder`, inverted: true while a chrome text field owns the caret.
 *
 * Capture-phase listeners on the document, for the reason `armCaretClaim` uses them - a field
 * that stops propagation of its own focus events must not be able to strand the answer.
 *
 * `focusout` is dispatched with `activeElement` already dropped to `<body>`, before the element
 * gaining focus is dispatched its `focusin`, so reading it there would report "no chrome field"
 * for one tick during every ordinary move between two chrome fields and flash the ring back to
 * full strength. The answer is therefore taken one task later, which is also what answers
 * Escape in the sidebar filter (a blur with nothing taking the caret). `focusin` still settles
 * the common case synchronously.
 */
export function useChromeCaret(): boolean {
    const [held, setHeld] = useState<boolean>(() => chromeCaretHeld());
    useEffect(() => {
        if (typeof document === 'undefined') return;
        let deferred: ReturnType<typeof setTimeout> | null = null;
        const decide = (): void => setHeld(chromeCaretHeld());
        const onFocusIn = (): void => {
            decide();
        };
        const onFocusOut = (): void => {
            if (deferred !== null) return;
            deferred = setTimeout(() => {
                deferred = null;
                decide();
            }, 0);
        };
        document.addEventListener('focusin', onFocusIn, true);
        document.addEventListener('focusout', onFocusOut, true);
        decide();
        return () => {
            if (deferred !== null) clearTimeout(deferred);
            document.removeEventListener('focusin', onFocusIn, true);
            document.removeEventListener('focusout', onFocusOut, true);
        };
    }, []);
    return held;
}
