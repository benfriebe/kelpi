import { afterEach, describe, expect, it } from 'vitest';

import { createFakePhoneWindow } from '../terminal/testing';
import { readSoftKeyboardInset, type FormFactorDocument } from './form-factor';
import {
    KEYBOARD_SCROLL_RESET_ATTEMPTS,
    KEYBOARD_VIEWPORT_ATTRIBUTE,
    bindKeyboardViewport,
    createKeyboardViewportTracker,
    resolveKeyboardViewportMode,
    type KeyboardViewportWindow
} from './keyboard-viewport';

/** An iPhone 14/15 in CSS px, and a keyboard about the size iOS actually raises. */
const HEIGHT = 844;
const KEYBOARD = 300;

const unbinds: (() => void)[] = [];

afterEach(() => {
    while (unbinds.length > 0) unbinds.pop()?.();
});

/** A `<html>`-shaped document double, so the attribute can be read back as an attribute. */
function fakeDocument(): { doc: FormFactorDocument; root: HTMLElement } {
    const root = document.createElement('div');
    return { doc: { documentElement: root }, root };
}

function bind(win: KeyboardViewportWindow): { root: HTMLElement; mode: () => string | null } {
    const { doc, root } = fakeDocument();
    unbinds.push(bindKeyboardViewport(doc, win));
    return { root, mode: () => root.getAttribute(KEYBOARD_VIEWPORT_ATTRIBUTE) };
}

describe('resolveKeyboardViewportMode', () => {
    it('says nothing is taking space when both viewports are the resting window', () => {
        expect(
            resolveKeyboardViewportMode({ restingLayoutHeight: HEIGHT, layoutHeight: HEIGHT, visualHeight: HEIGHT })
        ).toBe('none');
    });

    it('names the default Chrome and iOS shape: only the visual viewport shrank', () => {
        expect(
            resolveKeyboardViewportMode({
                restingLayoutHeight: HEIGHT,
                layoutHeight: HEIGHT,
                visualHeight: HEIGHT - KEYBOARD
            })
        ).toBe('resizes-visual');
    });

    it('names C7\'s shape: the layout viewport shrank with it', () => {
        expect(
            resolveKeyboardViewportMode({
                restingLayoutHeight: HEIGHT,
                layoutHeight: HEIGHT - KEYBOARD,
                visualHeight: HEIGHT - KEYBOARD
            })
        ).toBe('resizes-content');
    });

    it('treats a few px of drift as no keyboard, because iOS reports fractional heights', () => {
        expect(
            resolveKeyboardViewportMode({ restingLayoutHeight: HEIGHT, layoutHeight: HEIGHT - 2, visualHeight: HEIGHT - 3 })
        ).toBe('none');
    });

    it('reads a keyboard that OVERLAYS the content as nothing at all, which is what it is', () => {
        // `interactive-widget=overlays-content` resizes neither viewport, so the client cannot
        // see the keyboard by any measurement. Naming that `none` is the honest answer, not a
        // gap: there is nothing to inset and nothing to detect.
        expect(
            resolveKeyboardViewportMode({ restingLayoutHeight: HEIGHT, layoutHeight: HEIGHT, visualHeight: HEIGHT })
        ).toBe('none');
    });
});

describe('createKeyboardViewportTracker', () => {
    it('reads the keyboard, and the scroll the browser did on top of it', () => {
        const win = createFakePhoneWindow();
        const tracker = createKeyboardViewportTracker(win);
        expect(tracker.read()).toEqual({ mode: 'none', keyboard: 0, offsetTop: 0, scrollTop: 0 });

        win.raiseKeyboard(KEYBOARD, 1);
        expect(tracker.read()).toEqual({ mode: 'resizes-visual', keyboard: KEYBOARD, offsetTop: 0, scrollTop: 0 });

        // Chrome scrolls the visual viewport to keep the focused textarea in view. The KEYBOARD
        // is the same 300 px however far it scrolled: that is the difference between this reading
        // and `readSoftKeyboardInset`, which is the smaller number the pane's padding needs.
        win.scrollViewportTo(120);
        expect(tracker.read()).toEqual({ mode: 'resizes-visual', keyboard: KEYBOARD, offsetTop: 120, scrollTop: 0 });
        expect(readSoftKeyboardInset(win)).toBe(KEYBOARD - 120);
    });

    it('names the mode C7 asks Chrome for, and the pane takes no inset in it', () => {
        const win = createFakePhoneWindow();
        const tracker = createKeyboardViewportTracker(win);

        win.raiseKeyboardResizingContent(KEYBOARD, 15);
        expect(tracker.read()).toEqual({ mode: 'resizes-content', keyboard: KEYBOARD, offsetTop: 0, scrollTop: 0 });
        // The no-double-apply rule, as arithmetic rather than a branch: the layout viewport has
        // already given the keyboard its pixels, so there is nothing of it left hidden.
        expect(readSoftKeyboardInset(win)).toBe(0);
    });

    it('re-bases on a rotation, so 390x844 turning into 844x390 is not read as a 454 px keyboard', () => {
        const win = { innerWidth: 390, innerHeight: HEIGHT } as { innerWidth: number; innerHeight: number };
        const tracker = createKeyboardViewportTracker(win);
        expect(tracker.read().mode).toBe('none');

        win.innerWidth = HEIGHT;
        win.innerHeight = 390;
        expect(tracker.read()).toEqual({ mode: 'none', keyboard: 0, offsetTop: 0, scrollTop: 0 });
        expect(tracker.restingLayoutHeight()).toBe(390);
    });

    it('takes a taller layout viewport as the new resting height (a URL bar sliding away)', () => {
        const win = { innerWidth: 390, innerHeight: HEIGHT - 56 } as { innerWidth: number; innerHeight: number };
        const tracker = createKeyboardViewportTracker(win);
        expect(tracker.restingLayoutHeight()).toBe(HEIGHT - 56);

        win.innerHeight = HEIGHT;
        expect(tracker.read().mode).toBe('none');
        expect(tracker.restingLayoutHeight()).toBe(HEIGHT);
    });
});

describe('bindKeyboardViewport (C7 - the app never scrolls for the keyboard)', () => {
    it('publishes the mode on a phone, through a whole transition', () => {
        const win = createFakePhoneWindow();
        const { mode } = bind(win);
        expect(mode()).toBe('none');

        win.raiseKeyboard(KEYBOARD, 15);
        expect(mode()).toBe('resizes-visual');

        win.lowerKeyboard(15);
        expect(mode()).toBe('none');
    });

    it('publishes `resizes-content` when the window shrinks with the viewport', () => {
        const win = createFakePhoneWindow();
        const { mode } = bind(win);

        win.raiseKeyboardResizingContent(KEYBOARD, 15);
        expect(mode()).toBe('resizes-content');
    });

    it('writes nothing at all on a desktop window, and never touches its scroll', () => {
        // The narrow-window-with-a-mouse case: phone-sized, fine pointer, so `desktop`.
        const win = createFakePhoneWindow({ coarse: false });
        const { root } = bind(win);
        expect(root.hasAttribute(KEYBOARD_VIEWPORT_ATTRIBUTE)).toBe(false);

        win.raiseKeyboard(KEYBOARD, 3);
        win.scrollViewportTo(120);
        expect(root.hasAttribute(KEYBOARD_VIEWPORT_ATTRIBUTE)).toBe(false);
        expect(win.scrollCalls()).toBe(0);
    });

    it('takes the attribute back when the window stops being a phone', () => {
        const win = createFakePhoneWindow();
        const { root } = bind(win);
        expect(root.getAttribute(KEYBOARD_VIEWPORT_ATTRIBUTE)).toBe('none');

        // An iPad that gains a Bluetooth mouse flips `(pointer: coarse)` live.
        win.setPointer(false);
        expect(root.hasAttribute(KEYBOARD_VIEWPORT_ATTRIBUTE)).toBe(false);
    });

    it('asks for nothing while the app is where it should be', () => {
        const win = createFakePhoneWindow();
        bind(win);

        win.raiseKeyboard(KEYBOARD, 15);
        win.lowerKeyboard(15);
        expect(win.scrollCalls()).toBe(0);
    });

    it('puts the app back when the browser scrolls the visual viewport to reveal the prompt', () => {
        const win = createFakePhoneWindow();
        bind(win);

        win.raiseKeyboard(KEYBOARD, 15);
        win.scrollViewportTo(120);
        expect(win.scrollCalls()).toBe(1);
        expect(win.visualViewport?.offsetTop).toBe(0);
        // And the app is back at the top, so the next scroll is a fresh transition rather than
        // the second of three pushes.
        expect(readSoftKeyboardInset(win)).toBe(KEYBOARD);
    });

    it('puts it back when iOS scrolls the DOCUMENT instead', () => {
        const win = createFakePhoneWindow();
        bind(win);

        win.raiseKeyboard(KEYBOARD, 15);
        win.scrollDocumentTo(90);
        expect(win.scrollCalls()).toBe(1);
        expect(win.scrollY).toBe(0);
    });

    it('stops fighting a browser that refuses, and re-arms once the app is back', () => {
        // Whether `window.scrollTo` moves the VISUAL viewport is unsettled (Firefox moves both;
        // Chrome's own issue is open), so the rule must not depend on it. A browser that keeps
        // re-scrolling gets three pushes and then the app leaves it alone: C2's inset already
        // subtracts `offsetTop`, so the prompt stays visible either way.
        const win = createFakePhoneWindow({ honoursScrollTo: false });
        bind(win);
        win.raiseKeyboard(KEYBOARD, 15);

        for (let scroll = 1; scroll <= KEYBOARD_SCROLL_RESET_ATTEMPTS + 3; scroll += 1) {
            win.scrollViewportTo(100 + scroll);
        }
        expect(win.scrollCalls()).toBe(KEYBOARD_SCROLL_RESET_ATTEMPTS);

        // The browser gave it back on its own: the cap re-arms.
        win.scrollViewportTo(0);
        win.scrollViewportTo(140);
        expect(win.scrollCalls()).toBe(KEYBOARD_SCROLL_RESET_ATTEMPTS + 1);
    });

    it('drops every listener and the attribute when it is unbound', () => {
        const win = createFakePhoneWindow();
        const { doc, root } = fakeDocument();
        const stop = bindKeyboardViewport(doc, win);
        expect(win.listenerCount()).toBeGreaterThan(0);

        stop();
        expect(win.listenerCount()).toBe(0);
        expect(root.hasAttribute(KEYBOARD_VIEWPORT_ATTRIBUTE)).toBe(false);

        win.raiseKeyboard(KEYBOARD, 3);
        win.scrollViewportTo(120);
        expect(win.scrollCalls()).toBe(0);
        expect(root.hasAttribute(KEYBOARD_VIEWPORT_ATTRIBUTE)).toBe(false);
    });
});
