/**
 * The keyboard and the shell's bottom chrome (the pane strip and the location bar, which sit below
 * the content row).
 *
 * A keyboard reaches the page in one of two ways, and the shell answers each differently:
 *
 *   - as an INSET (iOS, and Chrome's default): the visual viewport is shorter than the layout one,
 *     the keyboard rises over the bottom of an unchanged window, and the chrome is simply under it.
 *     The key bar pads the content row by the part of the keyboard ABOVE the chrome
 *     (`PhoneKeyBar`'s `belowPx`), so nothing moves but the row's bottom edge and the bar sits on
 *     the keyboard. Nothing here is needed for that;
 *   - as a SHORTER WINDOW, under `interactive-widget=resizes-content` (`index.html`, Chrome on
 *     Android): the layout viewport shrinks with the keyboard, the inset stays zero, and the chrome
 *     would ride up above the keyboard and take 120 px of a terminal the person is typing into.
 *     The browser is resizing the whole layout at that moment anyway, so the shell takes the chrome
 *     away in the same change and puts it back when the window grows again.
 *
 * The second is read as the window losing a keyboard's worth of height against the tallest it has
 * been at this width, so a rotation (a new width) starts a new baseline rather than reading as a
 * keyboard.
 */

import { useEffect, useState } from 'react';

import type { FormFactorWindow } from '../chrome/form-factor';
import { watchSoftKeyboardMotion } from '../terminal';

/** Less than this is a browser toolbar sliding, not a keyboard. */
const KEYBOARD_MIN_PX = 120;

/** True while a keyboard has shrunk the WINDOW (resizes-content), not just the visual viewport. */
export function useWindowKeyboard(win: FormFactorWindow, enabled: boolean): boolean {
    const [up, setUp] = useState(false);

    useEffect(() => {
        if (!enabled) {
            setUp(false);
            return;
        }
        let width = win.innerWidth;
        let tallest = win.innerHeight;
        const read = (): void => {
            if (win.innerWidth !== width) {
                width = win.innerWidth;
                tallest = win.innerHeight;
            }
            tallest = Math.max(tallest, win.innerHeight);
            setUp(tallest - win.innerHeight >= KEYBOARD_MIN_PX);
        };
        const motion = watchSoftKeyboardMotion(win, { onMove: read, onSettle: read });
        read();
        return () => motion.dispose();
    }, [win, enabled]);

    return up;
}
