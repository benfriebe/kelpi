/**
 * The phone's back gesture closes a sheet, not the app.
 *
 * **An owner-directed divergence from the shipped Swift app**, like every phone rule in this
 * program (there is no Swift phone UI; `chrome/form-factor.ts` says so once for all of it).
 *
 * On the owner's phone (Android Chrome, installed, 2026-09-08) a swipe from the screen's edge is
 * the system's back gesture: it went back through the browser's history, and at the start of the
 * history it closed the app - with a drawer open, which is exactly when a person means "close
 * this". So a sheet pushes ONE history entry when it opens and owns it until it closes: the back
 * gesture pops the entry and the shell closes the sheet; a tap on the scrim, on Close or on a
 * row pops the same entry itself, so the history is what it was before the sheet. Switching from
 * one sheet to another (the drawer to Add host) keeps the one entry.
 *
 * Pure over an injected history-shaped object so the rule is testable in jsdom.
 */

import { useCallback, useEffect, useRef } from 'react';

export const PHONE_SHEET_HISTORY_STATE = 'kelpi.phone.sheet';

export interface SheetHistoryLike {
    pushState(data: unknown, unused: string): void;
    back(): void;
    readonly state: unknown;
    addEventListener(type: 'popstate', listener: () => void): void;
    removeEventListener(type: 'popstate', listener: () => void): void;
}

/** `window.history` plus the window's popstate, as one object; null where there is no window. */
export function defaultSheetHistory(): SheetHistoryLike | null {
    const win = (globalThis as { window?: Window }).window;
    if (win === undefined || typeof win.history?.pushState !== 'function') return null;
    return {
        pushState: (data, unused) => win.history.pushState(data, unused),
        back: () => win.history.back(),
        get state() {
            return win.history.state;
        },
        addEventListener: (type, listener) => win.addEventListener(type, listener),
        removeEventListener: (type, listener) => win.removeEventListener(type, listener)
    };
}

export function isSheetHistoryState(state: unknown): boolean {
    return typeof state === 'object' && state !== null && (state as Record<string, unknown>)[PHONE_SHEET_HISTORY_STATE] === true;
}

export interface SheetHistory {
    /** Call when a sheet is on screen (`open` true) or none is (`open` false). */
    readonly sync: (open: boolean) => void;
    /** Close from the UI: pops the entry the sheet pushed, which is what closes it. */
    readonly close: () => void;
}

/**
 * Bind the sheet's open state to one history entry.
 *
 * `onBack` is called when the person goes back with a sheet open; the caller closes the sheet.
 * `close()` is what the caller's own Close/scrim/row handlers run: it closes at once and pops
 * the entry the sheet pushed, if any; the popstate that follows is ignored.
 */
export function useSheetHistory(
    onBack: () => void,
    history: SheetHistoryLike | null | undefined = undefined
): SheetHistory {
    const target = history === undefined ? defaultSheetHistory() : history;
    const pushed = useRef(false);
    const onBackRef = useRef(onBack);
    onBackRef.current = onBack;

    useEffect(() => {
        if (target === null) return;
        const onPop = (): void => {
            if (!pushed.current) return;
            pushed.current = false;
            onBackRef.current();
        };
        target.addEventListener('popstate', onPop);
        return () => target.removeEventListener('popstate', onPop);
    }, [target]);

    const sync = useCallback(
        (open: boolean): void => {
            if (target === null) return;
            if (open && !pushed.current) {
                try {
                    target.pushState({ [PHONE_SHEET_HISTORY_STATE]: true }, '');
                    pushed.current = true;
                } catch {
                    pushed.current = false;
                }
            }
        },
        [target]
    );

    const close = useCallback((): void => {
        // Close NOW, then take the entry off: a tap must not wait for the browser's traversal
        // (asynchronous, and a task later in Chrome), and the popstate it raises finds the flag
        // already down, so nothing is closed twice.
        const owned = pushed.current;
        pushed.current = false;
        onBackRef.current();
        if (target !== null && owned) target.back();
    }, [target]);

    return { sync, close };
}
