import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    KEYBOARD_INSET_ATTRIBUTE,
    PHONE_KEYBOARD_SETTLE_MS,
    PHONE_TEXT_INPUT_ATTRIBUTES,
    PHONE_TEXT_INPUT_ATTRIBUTES_CLEARED,
    TERMINAL_RESIZES_ATTRIBUTE,
    TERMINAL_ROWS_ATTRIBUTE,
    clearPhoneTerminalState,
    heightUnderKeyboard,
    keyboardBoxInset,
    publishKeyboardInset,
    publishPhoneTerminalState,
    watchSoftKeyboardMotion
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

    it('moves the inset on its own for the per-frame path (C6)', () => {
        const root = document.createElement('div');
        publishPhoneTerminalState(root, { inset: 0, rows: 42, resizes: 1 });
        publishKeyboardInset(root, 180);
        expect(root.getAttribute(KEYBOARD_INSET_ATTRIBUTE)).toBe('180');
        // …and leaves the daemon's two numbers exactly where the last resize left them: a frame
        // of the animation is not a resize, and the audit reads the count as a delta.
        expect(root.getAttribute(TERMINAL_ROWS_ATTRIBUTE)).toBe('42');
        expect(root.getAttribute(TERMINAL_RESIZES_ATTRIBUTE)).toBe('1');
    });

    it('survives a null root (the pane publishes before React has attached its ref)', () => {
        expect(() => publishPhoneTerminalState(null, { inset: 1, rows: 2, resizes: 3 })).not.toThrow();
        expect(() => publishKeyboardInset(null, 4)).not.toThrow();
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

describe('keyboardBoxInset (C6 - the padding the pane takes for the keyboard)', () => {
    it('is the whole keyboard when the pane can afford it', () => {
        expect(keyboardBoxInset(844, 300, 16)).toBe(300);
    });

    it('is nothing at all with no keyboard, which is every desktop pane', () => {
        expect(keyboardBoxInset(844, 0, 16)).toBe(0);
    });

    it('never takes the last row: a keyboard taller than the pane still leaves a line to type on', () => {
        // The complement of `heightUnderKeyboard(260, 300, 16) === 16`.
        expect(keyboardBoxInset(260, 300, 16)).toBe(244);
    });

    it('takes nothing from a pane that is already shorter than one cell', () => {
        expect(keyboardBoxInset(9, 300, 16)).toBe(0);
    });
});

describe('watchSoftKeyboardMotion (C6)', () => {
    /** Both callbacks, in the order they were called, as `move:N` / `settle:N`. */
    function record(win: ReturnType<typeof createFakePhoneWindow>, settleMs?: number) {
        const seen: string[] = [];
        const motion = watchSoftKeyboardMotion(
            win,
            {
                onMove: (inset) => seen.push(`move:${String(inset)}`),
                onSettle: (inset) => seen.push(`settle:${String(inset)}`)
            },
            settleMs
        );
        return { seen, motion };
    }

    it('seeds from the viewport and says nothing about it', () => {
        const win = createFakePhoneWindow();
        win.raiseKeyboard(300, 1);
        const { seen, motion } = record(win);
        // A pane that mounts with the keyboard already up reads `live()` on its first pass; that
        // is not a transition, so it neither moves anything nor arms the settle.
        expect(motion.live()).toBe(300);
        expect(motion.moving()).toBe(false);
        expect(seen).toEqual([]);
        motion.dispose();
    });

    it('reports every frame of the animation and settles exactly once', () => {
        const win = createFakePhoneWindow();
        const { seen, motion } = record(win);

        // iOS animates for roughly 250-300 ms and fires `resize` on most frames.
        win.raiseKeyboard(300, 15);
        expect(win.viewportEvents()).toBe(15);
        expect(seen.filter((event) => event.startsWith('move:')).length).toBe(15);
        expect(seen.at(-1)).toBe('move:300');
        expect(seen.some((event) => event.startsWith('settle:'))).toBe(false);
        expect(motion.moving()).toBe(true);

        vi.advanceTimersByTime(PHONE_KEYBOARD_SETTLE_MS);
        expect(seen.at(-1)).toBe('settle:300');
        expect(seen.filter((event) => event.startsWith('settle:')).length).toBe(1);
        expect(motion.moving()).toBe(false);
        motion.dispose();
    });

    it('settles on the value at REST, not the frame that armed the timer', () => {
        const win = createFakePhoneWindow();
        const { seen, motion } = record(win);

        win.raiseKeyboard(100, 1);
        vi.advanceTimersByTime(PHONE_KEYBOARD_SETTLE_MS - 20); // not settled yet
        win.raiseKeyboard(300, 1);
        vi.advanceTimersByTime(PHONE_KEYBOARD_SETTLE_MS);
        expect(seen.filter((event) => event.startsWith('settle:'))).toEqual(['settle:300']);
        motion.dispose();
    });

    it('follows a wobble out and back, and still settles only once', () => {
        const win = createFakePhoneWindow();
        const { seen, motion } = record(win);

        // iOS moves `offsetTop` on scroll and back again. The box follows both ways - that is
        // what "the layout follows the viewport" means - and the pane's own unchanged-geometry
        // check is what keeps the daemon out of it (`TerminalPane.keyboard.test.tsx`).
        win.raiseKeyboard(40, 1);
        win.lowerKeyboard(1);
        vi.advanceTimersByTime(PHONE_KEYBOARD_SETTLE_MS * 4);
        expect(seen).toEqual(['move:40', 'move:0', 'settle:0']);
        motion.dispose();
    });

    it('ignores an event that repeats the inset, so a scroll storm cannot hold the settle open', () => {
        const win = createFakePhoneWindow();
        const { seen, motion } = record(win);

        win.raiseKeyboard(300, 1);
        for (let index = 0; index < 20; index += 1) {
            vi.advanceTimersByTime(PHONE_KEYBOARD_SETTLE_MS - 20);
            win.scrollViewport();
        }
        vi.advanceTimersByTime(PHONE_KEYBOARD_SETTLE_MS);
        expect(seen).toEqual(['move:300', 'settle:300']);
        motion.dispose();
    });

    it('drops its timer and its listeners on dispose', () => {
        const win = createFakePhoneWindow();
        const { seen, motion } = record(win);
        expect(win.listenerCount()).toBeGreaterThan(0);

        win.raiseKeyboard(300, 3);
        motion.dispose();
        vi.advanceTimersByTime(PHONE_KEYBOARD_SETTLE_MS * 4);
        expect(seen.some((event) => event.startsWith('settle:'))).toBe(false);
        expect(win.listenerCount()).toBe(0);
    });
});
