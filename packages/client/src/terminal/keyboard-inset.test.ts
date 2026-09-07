import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    KEYBOARD_INSET_ATTRIBUTE,
    PHONE_KEYBOARD_SETTLE_MS,
    PHONE_TEXT_INPUT_ATTRIBUTES,
    PHONE_TEXT_INPUT_ATTRIBUTES_CLEARED,
    TERMINAL_RESIZES_ATTRIBUTE,
    TERMINAL_ROWS_ATTRIBUTE,
    clearPhoneTerminalState,
    createSoftKeyboardInsetSource,
    heightUnderKeyboard,
    publishPhoneTerminalState,
    useSettledSoftKeyboardInset
} from './keyboard-inset';
import { createFakePhoneWindow } from './testing';

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('heightUnderKeyboard', () => {
    it('is the identity with no keyboard, which is every desktop pane', () => {
        expect(heightUnderKeyboard(480, 0, 16)).toBe(480);
        // A negative inset cannot happen (`readSoftKeyboardInset` clamps at zero) but the
        // function is total anyway: it must never GROW a pane.
        expect(heightUnderKeyboard(480, -20, 16)).toBe(480);
    });

    it('takes the keyboard off the bottom', () => {
        expect(heightUnderKeyboard(844, 300, 16)).toBe(544);
    });

    it('never falls below one row, so a keyboard taller than the pane still leaves a line', () => {
        // An iPhone SE split pane under a 300 px keyboard. Zero would trip the pane's zero-size
        // guard, send NO resize at all, and leave the terminal at its full pre-keyboard rows.
        expect(heightUnderKeyboard(260, 300, 16)).toBe(16);
    });

    it('never grows a pane that is already shorter than one cell', () => {
        expect(heightUnderKeyboard(9, 300, 16)).toBe(9);
    });
});

describe('the phone attributes a pane publishes', () => {
    it('writes the three numbers the audit reads, and takes all three back', () => {
        const root = document.createElement('div');
        publishPhoneTerminalState(root, { inset: 300, rows: 34, resizes: 2 });
        expect(root.getAttribute(KEYBOARD_INSET_ATTRIBUTE)).toBe('300');
        expect(root.getAttribute(TERMINAL_ROWS_ATTRIBUTE)).toBe('34');
        expect(root.getAttribute(TERMINAL_RESIZES_ATTRIBUTE)).toBe('2');

        clearPhoneTerminalState(root);
        expect(root.hasAttribute(KEYBOARD_INSET_ATTRIBUTE)).toBe(false);
        expect(root.hasAttribute(TERMINAL_ROWS_ATTRIBUTE)).toBe(false);
        expect(root.hasAttribute(TERMINAL_RESIZES_ATTRIBUTE)).toBe(false);
    });

    it('survives a null root (the pane publishes before React has attached its ref)', () => {
        expect(() => publishPhoneTerminalState(null, { inset: 1, rows: 2, resizes: 3 })).not.toThrow();
        expect(() => clearPhoneTerminalState(null)).not.toThrow();
    });
});

describe('the phone text-input attributes', () => {
    it('are the five a software keyboard needs, and the clear takes back only the two we added', () => {
        expect(PHONE_TEXT_INPUT_ATTRIBUTES).toEqual({
            autocapitalize: 'off',
            autocorrect: 'off',
            spellcheck: 'false',
            inputmode: 'text',
            enterkeyhint: 'send'
        });
        // The other three belong to the engine, which sets them on every textarea it builds on
        // every platform; removing them would be the phone program editing a desktop terminal.
        expect(PHONE_TEXT_INPUT_ATTRIBUTES_CLEARED).toEqual({ inputmode: null, enterkeyhint: null });
    });
});

describe('createSoftKeyboardInsetSource', () => {
    it('seeds from the viewport, so a pane that mounts with the keyboard already up is right', () => {
        const win = createFakePhoneWindow();
        win.raiseKeyboard(300, 1);
        const source = createSoftKeyboardInsetSource(win);
        expect(source.read()).toBe(300);
        source.dispose();
    });

    it('publishes ONCE per transition, however many frames the animation takes', () => {
        const win = createFakePhoneWindow();
        const source = createSoftKeyboardInsetSource(win);
        const seen: number[] = [];
        source.subscribe(() => seen.push(source.read()));

        // iOS animates for roughly 250-300 ms and fires `resize` on most frames.
        win.raiseKeyboard(300, 15);
        expect(win.viewportEvents()).toBe(15);
        expect(seen).toEqual([]); // nothing published while the viewport is still moving

        vi.advanceTimersByTime(PHONE_KEYBOARD_SETTLE_MS);
        expect(seen).toEqual([300]);

        win.lowerKeyboard(15);
        vi.advanceTimersByTime(PHONE_KEYBOARD_SETTLE_MS);
        expect(seen).toEqual([300, 0]);
        expect(win.viewportEvents()).toBe(30);
        source.dispose();
    });

    it('publishes the value at REST, not the frame that armed the timer', () => {
        const win = createFakePhoneWindow();
        const source = createSoftKeyboardInsetSource(win);
        const seen: number[] = [];
        source.subscribe(() => seen.push(source.read()));

        win.raiseKeyboard(100, 1);
        vi.advanceTimersByTime(PHONE_KEYBOARD_SETTLE_MS - 20); // not settled yet
        win.raiseKeyboard(300, 1);
        vi.advanceTimersByTime(PHONE_KEYBOARD_SETTLE_MS);
        expect(seen).toEqual([300]);
        source.dispose();
    });

    it('says nothing at all about a wobble that comes back', () => {
        const win = createFakePhoneWindow();
        const source = createSoftKeyboardInsetSource(win);
        const seen: number[] = [];
        source.subscribe(() => seen.push(source.read()));

        // iOS moves `offsetTop` on scroll and back again; the inset ends where it started.
        win.raiseKeyboard(40, 1);
        win.lowerKeyboard(1);
        vi.advanceTimersByTime(PHONE_KEYBOARD_SETTLE_MS * 4);
        expect(seen).toEqual([]);
        source.dispose();
    });

    it('drops its timer and its listeners on dispose', () => {
        const win = createFakePhoneWindow();
        const source = createSoftKeyboardInsetSource(win);
        const seen: number[] = [];
        source.subscribe(() => seen.push(source.read()));
        expect(win.listenerCount()).toBeGreaterThan(0);

        win.raiseKeyboard(300, 3);
        source.dispose();
        vi.advanceTimersByTime(PHONE_KEYBOARD_SETTLE_MS * 4);
        expect(seen).toEqual([]);
        expect(win.listenerCount()).toBe(0);
    });
});

describe('useSettledSoftKeyboardInset', () => {
    it('subscribes to nothing and answers 0 when it is not enabled (every desktop pane)', () => {
        const win = createFakePhoneWindow();
        const { result } = renderHook(() => useSettledSoftKeyboardInset(false, win));
        expect(result.current).toBe(0);
        expect(win.listenerCount()).toBe(0);

        act(() => {
            win.raiseKeyboard(300, 15);
            vi.advanceTimersByTime(PHONE_KEYBOARD_SETTLE_MS * 4);
        });
        expect(result.current).toBe(0);
    });

    it('publishes the settled inset once the keyboard has come to rest', () => {
        const win = createFakePhoneWindow();
        const { result } = renderHook(() => useSettledSoftKeyboardInset(true, win));
        expect(result.current).toBe(0);

        act(() => {
            win.raiseKeyboard(300, 15);
        });
        expect(result.current).toBe(0);

        act(() => {
            vi.advanceTimersByTime(PHONE_KEYBOARD_SETTLE_MS);
        });
        expect(result.current).toBe(300);

        act(() => {
            win.lowerKeyboard(15);
            vi.advanceTimersByTime(PHONE_KEYBOARD_SETTLE_MS);
        });
        expect(result.current).toBe(0);
    });

    it('drops back to 0 and unsubscribes the moment it stops being enabled', () => {
        const win = createFakePhoneWindow();
        const { result, rerender } = renderHook(
            ({ enabled }: { enabled: boolean }) => useSettledSoftKeyboardInset(enabled, win),
            { initialProps: { enabled: true } }
        );
        act(() => {
            win.raiseKeyboard(300, 4);
            vi.advanceTimersByTime(PHONE_KEYBOARD_SETTLE_MS);
        });
        expect(result.current).toBe(300);

        rerender({ enabled: false });
        expect(result.current).toBe(0);
        expect(win.listenerCount()).toBe(0);
    });

    it('unsubscribes on unmount', () => {
        const win = createFakePhoneWindow();
        const { unmount } = renderHook(() => useSettledSoftKeyboardInset(true, win));
        expect(win.listenerCount()).toBeGreaterThan(0);
        unmount();
        expect(win.listenerCount()).toBe(0);
    });
});
