/**
 * Issue #79: the global gesture reset (`chrome/gesture-reset.ts`).
 *
 * The registry itself, over jsdom's `window`. The two callers are pinned where they live:
 * `sidebar-resizer-lockout.test.tsx` and `grid/PaneGrid.gesture-reset.test.tsx`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    expectOwnFocusHandoff,
    registerGestureReset,
    registeredGestureCount,
    resetGestures,
    setGestureResetClock
} from './gesture-reset';

const unregisters: Array<() => void> = [];

function register(reset: (reason: string) => void): void {
    unregisters.push(registerGestureReset(reset as never));
}

afterEach(() => {
    while (unregisters.length > 0) unregisters.pop()?.();
    setGestureResetClock(null);
});

function hide(state: 'hidden' | 'visible'): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
}

describe('gesture reset registry', () => {
    it('runs every registered reset when the window loses focus', () => {
        const a = vi.fn();
        const b = vi.fn();
        register(a);
        register(b);

        window.dispatchEvent(new Event('blur'));

        expect(a).toHaveBeenCalledWith('blur');
        expect(b).toHaveBeenCalledWith('blur');
    });

    it('runs them when the document goes hidden, and not when it comes back', () => {
        const reset = vi.fn();
        register(reset);

        hide('hidden');
        expect(reset).toHaveBeenCalledWith('hidden');

        reset.mockClear();
        hide('visible');
        expect(reset).not.toHaveBeenCalled();
    });

    it('unregisters cleanly, and a reset that throws does not strand its neighbours', () => {
        const stranded = vi.fn();
        register(() => {
            throw new Error('one gesture’s teardown blew up');
        });
        register(stranded);

        expect(resetGestures()).toBe(2);
        expect(stranded).toHaveBeenCalledWith('manual');

        const before = registeredGestureCount();
        const off = registerGestureReset(vi.fn());
        expect(registeredGestureCount()).toBe(before + 1);
        off();
        expect(registeredGestureCount()).toBe(before);
    });

    it('removes its window listeners once the last gesture unregisters', () => {
        const reset = vi.fn();
        const off = registerGestureReset(reset);
        off();

        window.dispatchEvent(new Event('blur'));
        expect(reset).not.toHaveBeenCalled();

        // …and a later registration re-installs them, so the teardown is not one-way.
        const again = vi.fn();
        const off2 = registerGestureReset(again);
        window.dispatchEvent(new Event('blur'));
        expect(again).toHaveBeenCalledWith('blur');
        off2();
    });

    /*
     * The integration of #79 with the web pane's keyboard claim. Focusing a web pane makes the
     * client send `web-focus-view`; the shell answers with `contents.focus()` on the pane's
     * native view and this document is blurred by its own request. Pressing a web pane's HEADER
     * does that AND arms the pane-move gesture, so an unqualified reset cancelled the move two
     * milliseconds after it started.
     */
    describe('a blur the client asked for itself', () => {
        it('ends nothing, and only the ONE blur it predicted', () => {
            const reset = vi.fn();
            register(reset);

            expectOwnFocusHandoff();
            window.dispatchEvent(new Event('blur'));
            expect(reset).not.toHaveBeenCalled();

            // The prediction is spent. A second blur is the ordinary kind again, even though it
            // lands well inside the same grace window.
            window.dispatchEvent(new Event('blur'));
            expect(reset).toHaveBeenCalledTimes(1);
            expect(reset).toHaveBeenCalledWith('blur');
        });

        it('expires, so a prediction nothing answered cannot swallow a real blur later', () => {
            let clock = 1_000;
            setGestureResetClock(() => clock);
            const reset = vi.fn();
            register(reset);

            expectOwnFocusHandoff();
            // The handoff never produced a blur (the verb was refused, the view was gone). Time
            // passes; the next blur is the user leaving.
            clock += 251;
            window.dispatchEvent(new Event('blur'));

            expect(reset).toHaveBeenCalledTimes(1);
            expect(reset).toHaveBeenCalledWith('blur');
        });

        it('does not excuse the document going hidden, or the recovery chord', () => {
            const reset = vi.fn();
            register(reset);

            expectOwnFocusHandoff();
            hide('hidden');
            expect(reset).toHaveBeenCalledWith('hidden');

            reset.mockClear();
            hide('visible');
            expectOwnFocusHandoff();
            expect(resetGestures('manual')).toBe(1);
            expect(reset).toHaveBeenCalledWith('manual');
        });
    });

    it('lets a reset unregister itself from inside the run', () => {
        const seen: string[] = [];
        let off: (() => void) | null = null;
        off = registerGestureReset(() => {
            seen.push('self');
            off?.();
        });
        register(() => seen.push('neighbour'));

        resetGestures('manual');
        // Both ran even though the first removed itself mid-iteration.
        expect(seen).toEqual(['self', 'neighbour']);
    });
});
