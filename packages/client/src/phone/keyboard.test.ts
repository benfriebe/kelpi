import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { FormFactorWindow } from '../chrome/form-factor';
import { useWindowKeyboard } from './keyboard';

/** A window whose layout viewport can shrink, as Chrome on Android's does for a keyboard. */
function shrinkingWindow(): FormFactorWindow & { resize(width: number, height: number): void } {
    const listeners = new Set<() => void>();
    const win = {
        innerWidth: 390,
        innerHeight: 844,
        visualViewport: null,
        addEventListener: (type: string, listener: () => void) => {
            if (type === 'resize') listeners.add(listener);
        },
        removeEventListener: (type: string, listener: () => void) => {
            if (type === 'resize') listeners.delete(listener);
        },
        resize(width: number, height: number): void {
            win.innerWidth = width;
            win.innerHeight = height;
            for (const listener of listeners) listener();
        }
    };
    return win;
}

describe('useWindowKeyboard', () => {
    it('is up while a keyboard has shrunk the window, and down when it grows back', () => {
        const win = shrinkingWindow();
        const { result } = renderHook(() => useWindowKeyboard(win, true));
        expect(result.current).toBe(false);
        act(() => win.resize(390, 544));
        expect(result.current).toBe(true);
        act(() => win.resize(390, 844));
        expect(result.current).toBe(false);
    });

    it('ignores a browser toolbar sliding, and a rotation, which is a new width', () => {
        const win = shrinkingWindow();
        const { result } = renderHook(() => useWindowKeyboard(win, true));
        act(() => win.resize(390, 790));
        expect(result.current).toBe(false);
        act(() => win.resize(844, 390));
        expect(result.current).toBe(false);
    });

    it('is never up when disabled', () => {
        const win = shrinkingWindow();
        const { result } = renderHook(() => useWindowKeyboard(win, false));
        act(() => win.resize(390, 500));
        expect(result.current).toBe(false);
    });
});
