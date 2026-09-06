/**
 * Issue #79 — the global gesture reset (`chrome/gesture-reset.ts`).
 *
 * The registry itself, over jsdom's `window`. The two callers are pinned where they live:
 * `sidebar-resizer-lockout.test.tsx` and `grid/PaneGrid.gesture-reset.test.tsx`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerGestureReset, registeredGestureCount, resetGestures } from './gesture-reset';

const unregisters: Array<() => void> = [];

function register(reset: (reason: string) => void): void {
    unregisters.push(registerGestureReset(reset as never));
}

afterEach(() => {
    while (unregisters.length > 0) unregisters.pop()?.();
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
