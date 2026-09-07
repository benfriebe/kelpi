/**
 * Where a software keyboard puts the app, and how the app refuses to move for it (C7,
 * docs/MOBILE-PLAN.md section 7).
 *
 * **Owner-directed divergence.** There is no Swift phone UI to port; `chrome/form-factor.ts` says
 * that once for the whole phone program, and this module is one more of the owner's rules.
 *
 * ## The rule
 *
 * On a phone the app never scrolls for the keyboard. The title bar stays at the top of the
 * screen, the focused pane's bottom edge (its key bar) stays directly above whatever the app
 * draws above the keyboard, and the status footer keeps its place between the two. Nothing the
 * browser does to reveal a focused field may move the app inside its own window.
 *
 * ## What the owner's device did instead (Android, Chrome, installed PWA, round 5, 2026-09-07)
 *
 * Two screenshots. With the keyboard up the app's 32 px title bar, the pane header, the terminal
 * and the key bar were on screen, then a black gap of about 40 px, then the keyboard, with the
 * 24 px status footer nowhere: it was under the keyboard. After `seq 1 200` filled the pane the
 * title bar and the pane header were GONE off the top, the terminal's first visible row started
 * under the Android status bar, and the footer had surfaced above the keyboard. The owner: "the
 * bar can be disconnected from the bottom of the panel, and the screen can no longer show the top
 * of the app when the keyboard opens".
 *
 * Both shapes are one cause. Chrome 108 made `interactive-widget=resizes-visual` the DEFAULT on
 * Android: the LAYOUT viewport keeps its full height for a keyboard and only the VISUAL viewport
 * shrinks, after which Chrome scrolls the visual viewport (a nonzero `visualViewport.offsetTop`)
 * to keep the focused element in view. The engine's hidden textarea sits at the prompt, so the
 * further down the pane the prompt is, the further Chrome scrolls, and a `height: 100%`,
 * `overflow: hidden` shell has no way to notice: its box is still the full layout viewport, so
 * the title bar simply leaves the screen and the footer, which the layout puts below the panes,
 * comes into it. The black gap is the same arithmetic seen from the other end - C6's padding is
 * measured to the bottom of the LAYOUT viewport, and the pane's bottom edge is a footer's height
 * above that, so the padding overshoots by exactly the footer.
 *
 * MOBILE-PLAN.md section 7's C2 note recorded the assumption the wrong way round ("on Android the
 * LAYOUT viewport also shrinks for a keyboard"). It predates the device round. The correction is
 * here and in `terminal/keyboard-inset.ts`.
 *
 * ## What C7 does about it
 *
 *   1. `index.html` asks for `interactive-widget=resizes-content`, so the layout viewport shrinks
 *      with the visual one, the 100% height app IS the space above the keyboard, the pane's
 *      ResizeObserver sees the new height, and there is nothing left for Chrome to scroll. That
 *      is the whole fix on Chrome 108+ and Firefox 132+, and it is the only fix that keeps the
 *      title bar on screen without the client fighting the browser for the scroll position.
 *   2. For every engine that ignores the key - iOS and iPadOS ignore it, and so does Chrome 107
 *      and older - this module watches the visual viewport and puts the app back whenever the
 *      browser has scrolled it. See {@link bindKeyboardViewport} for what "puts it back" can and
 *      cannot promise.
 *
 * The footer is left where it is, on purpose. Under `resizes-content` the app's box is the space
 * above the keyboard, so the footer is a 24 px strip between the key bar and the keyboard rather
 * than something covering the terminal: the owner's "disconnected bar" was the SCROLL, not the
 * footer, and it goes away with the scroll. Hiding it would be a rule about what a phone shell
 * shows, and B1 owns that; C7 does not add a second owner for the footer.
 *
 * ## What this module does NOT own
 *
 * The pane's own box. `terminal/keyboard-inset.ts` (C2, C6) applies the keyboard as a bottom
 * padding on the pane root and is still the ONE place a terminal is inset (section 7, "Keyboard
 * inset ownership"). The two cannot double-apply, and that is arithmetic rather than a branch:
 * the pane's inset is `innerHeight - visualViewport.height - offsetTop`, which is the part of the
 * layout viewport's bottom that is hidden, so a layout viewport that has already given those
 * pixels up reports nothing left to hide. `resizes-content` therefore takes the pane's padding to
 * zero on its own, in the same frame the window shrinks.
 */

import { currentFormFactor, watchFormFactor, type FormFactorDocument, type FormFactorWindow } from './form-factor';

/** The attribute {@link bindKeyboardViewport} writes on `<html>`, phone only. */
export const KEYBOARD_VIEWPORT_ATTRIBUTE = 'data-keyboard-viewport';

/**
 * How the browser is giving the keyboard its space, as the client can measure it.
 *
 *   - `resizes-content`: the layout viewport shrank, so the app's own box is already the space
 *     above the keyboard. Chrome 108+ / Firefox 132+ with C7's viewport meta.
 *   - `resizes-visual`: only the visual viewport shrank, so the app's box still spans the
 *     keyboard and the browser may scroll it. Every engine that ignores the meta key.
 *   - `none`: no keyboard is taking space from either viewport. That is every desktop window,
 *     every phone with the keyboard down, and also a keyboard that OVERLAYS the content
 *     (`interactive-widget=overlays-content`), which is invisible to script by construction.
 */
export type KeyboardViewportMode = 'none' | 'resizes-content' | 'resizes-visual';

/**
 * The slack in the comparison, in CSS px.
 *
 * iOS reports fractional viewport heights and Chrome rounds differently between the two
 * viewports, so "unchanged" has to mean "within a few px". Four is above the fractions and two
 * orders of magnitude below a keyboard (about 300 px on an iPhone), so no keyboard can hide
 * inside it and no rounding can look like one.
 */
export const KEYBOARD_VIEWPORT_TOLERANCE_PX = 4;

/**
 * How many times a single keyboard transition may push the app back to the top before the client
 * gives up and leaves the browser alone. See {@link bindKeyboardViewport}.
 */
export const KEYBOARD_SCROLL_RESET_ATTEMPTS = 3;

/** The three heights the mode is decided from, so the decision is testable as data. */
export interface KeyboardViewportSample {
    /** The layout viewport's height with no keyboard in it, in CSS px. */
    readonly restingLayoutHeight: number;
    /** The layout viewport's height now (`window.innerHeight`). */
    readonly layoutHeight: number;
    /** The visual viewport's height now (`visualViewport.height`). */
    readonly visualHeight: number;
}

/**
 * Which resize behaviour the browser is actually giving us, from the measurements alone.
 *
 * The question is the one the Chrome documentation frames the modes with: does `innerHeight`
 * shrink with `visualViewport.height`, or does only the visual viewport move? Asking the
 * measurements rather than the user agent is what keeps this honest across a Chrome that has not
 * shipped the key yet, a Firefox that has, an iOS that never will, and an Android WebView that
 * answers for itself.
 *
 * A keyboard is not the only thing that can shorten a layout viewport: a phone browser's URL bar
 * sliding back in shrinks `innerHeight` by roughly 56 px with no keyboard anywhere, and this
 * reads that as `resizes-content` because geometrically it IS that - the app got a shorter
 * window and follows it. That mis-naming costs nothing, because nothing branches on the mode:
 * the pane's inset is arithmetic (see the header) and the scroll guard below asks about the
 * scroll, not about the mode. The mode is a REPORT, published for the audit and for the owner's
 * device round, and the installed PWA the owner runs has no URL bar to confuse it with.
 */
export function resolveKeyboardViewportMode(sample: KeyboardViewportSample): KeyboardViewportMode {
    const layoutDrop = sample.restingLayoutHeight - sample.layoutHeight;
    const visualDrop = sample.layoutHeight - sample.visualHeight;
    if (layoutDrop <= KEYBOARD_VIEWPORT_TOLERANCE_PX && visualDrop <= KEYBOARD_VIEWPORT_TOLERANCE_PX) {
        return 'none';
    }
    return layoutDrop > KEYBOARD_VIEWPORT_TOLERANCE_PX ? 'resizes-content' : 'resizes-visual';
}

/** What one look at the window says. */
export interface KeyboardViewportReading {
    readonly mode: KeyboardViewportMode;
    /**
     * How tall the keyboard is, in CSS px: the resting window minus what is visible of it.
     *
     * Deliberately NOT `readSoftKeyboardInset`, which is the smaller number the pane's padding
     * needs ("how much of the layout viewport's bottom is hidden", i.e. the keyboard less
     * whatever the browser has already scrolled away). This one is the keyboard itself, and it
     * is the same number in both modes, which is what makes it worth reporting.
     */
    readonly keyboard: number;
    /** How far the browser has scrolled the visual viewport inside the layout one. */
    readonly offsetTop: number;
    /** How far it has scrolled the document instead, which is iOS's shape of the same move. */
    readonly scrollTop: number;
}

/** The window this module reads. The real `window` satisfies it. */
export interface KeyboardViewportWindow extends FormFactorWindow {
    readonly scrollY?: number | undefined;
    scrollTo?: ((x: number, y: number) => void) | undefined;
}

/** The page's own window, or a zero-sized stand-in (SSR, a bare Node import). */
export function defaultKeyboardViewportWindow(): KeyboardViewportWindow {
    const win = (globalThis as { window?: KeyboardViewportWindow }).window;
    return win ?? { innerWidth: 0, innerHeight: 0 };
}

/** A tracker, because the mode cannot be read from one instant. */
export interface KeyboardViewportTracker {
    /** The window as it stands, and the resting height re-based if this look was a taller one. */
    read(): KeyboardViewportReading;
    /** The layout height the mode is being compared against. Exported for the tests. */
    restingLayoutHeight(): number;
}

/**
 * Remember the layout viewport's resting height, so the mode can be read from the change.
 *
 * A keyboard in `resizes-content` mode makes the page look EXACTLY like a shorter window, which
 * is the point of the mode, so there is no instant at which the two can be told apart: the
 * detection needs the height the window had before. The baseline is keyed to the WIDTH because a
 * software keyboard never changes it, and a rotation changes both, so a rotation re-bases rather
 * than being read as a 450 px keyboard. Any layout viewport TALLER than the baseline replaces it,
 * which is how the URL bar sliding away, an Android display cutout mode, or a desktop window
 * being dragged bigger get absorbed.
 */
export function createKeyboardViewportTracker(win: KeyboardViewportWindow): KeyboardViewportTracker {
    let restingWidth = win.innerWidth;
    let restingHeight = win.innerHeight;
    return {
        read(): KeyboardViewportReading {
            const layoutHeight = win.innerHeight;
            if (win.innerWidth !== restingWidth || layoutHeight > restingHeight) {
                restingWidth = win.innerWidth;
                restingHeight = layoutHeight;
            }
            const viewport = win.visualViewport ?? null;
            const visualHeight = viewport?.height ?? layoutHeight;
            return {
                mode: resolveKeyboardViewportMode({
                    restingLayoutHeight: restingHeight,
                    layoutHeight,
                    visualHeight
                }),
                keyboard: Math.max(0, Math.round(restingHeight - visualHeight)),
                offsetTop: Math.max(0, Math.round(viewport?.offsetTop ?? 0)),
                scrollTop: Math.max(0, Math.round(win.scrollY ?? 0))
            };
        },
        restingLayoutHeight: () => restingHeight
    };
}

/**
 * Publish the mode on `<html>` and keep the app at the top of its own window. Returns an
 * unsubscribe.
 *
 * Called once from `main.tsx`, next to `bindFormFactorAttribute`, for the life of the page.
 *
 * ## The guard, and what it can honestly promise
 *
 * Whenever the browser has scrolled the app - `visualViewport.offsetTop` on Chrome and Safari,
 * or the document itself on iOS, where the page scrolls to reveal a focused field even under
 * `overflow: hidden` - the client asks for it back with `scrollTo(0, 0)`. Two things are worth
 * being precise about, because neither can be measured off a device:
 *
 *   - whether `window.scrollTo` moves the VISUAL viewport at all is not settled. Firefox sets
 *     both offsets; Chrome's own issue for it (WICG/visual-viewport#61) is open. So this is a
 *     REQUEST, and the rule does not depend on it being granted: `styles.css` already pins the
 *     document at `height: 100%` with `overflow: hidden`, so there is never any document scroll
 *     of the user's to undo, and C2's inset already subtracts `offsetTop`, so the prompt line
 *     stays inside the visible band whether the browser gives the scroll back or keeps it. What
 *     the guard buys, when it is honoured, is the title bar.
 *   - it must not fight. Each reset that the browser honours arrives back as a `scroll` event
 *     reading zero, which disarms it; a browser that re-scrolls would otherwise get a reset per
 *     scroll forever. {@link KEYBOARD_SCROLL_RESET_ATTEMPTS} caps that at three pushes per
 *     transition and then yields, and the cap re-arms as soon as the app is back at the top.
 *
 * Phone only. A desktop window has no software keyboard, so it can never reach the guard, and
 * this writes no attribute at all there: a desktop DOM is byte-identical to what it was before
 * C7 (MOBILE-PLAN.md section 3, principle 1).
 */
export function bindKeyboardViewport(
    doc: FormFactorDocument = document,
    win: KeyboardViewportWindow = (doc.defaultView as KeyboardViewportWindow | null | undefined) ??
        defaultKeyboardViewportWindow()
): () => void {
    const tracker = createKeyboardViewportTracker(win);
    let pushes = 0;

    const apply = (): void => {
        if (currentFormFactor(win) !== 'phone') {
            delete doc.documentElement.dataset['keyboardViewport'];
            pushes = 0;
            return;
        }
        const reading = tracker.read();
        doc.documentElement.dataset['keyboardViewport'] = reading.mode;
        if (reading.offsetTop === 0 && reading.scrollTop === 0) {
            pushes = 0;
            return;
        }
        if (pushes >= KEYBOARD_SCROLL_RESET_ATTEMPTS) return;
        pushes += 1;
        win.scrollTo?.(0, 0);
    };

    apply();
    // `watchFormFactor` is the pointer query, the window's resize and the visual viewport's
    // resize. The two SCROLLS are this module's own, because a browser that moves the app to
    // reveal a focused field resizes nothing: Chrome moves the visual viewport inside the layout
    // one (`visualViewport` scroll) and iOS scrolls the document under it (the window's scroll,
    // which in a shell pinned at `height: 100%` with `overflow: hidden` can only ever be the
    // browser's doing).
    const stopWatching = watchFormFactor(win, apply);
    const viewport = win.visualViewport ?? null;
    viewport?.addEventListener?.('scroll', apply);
    win.addEventListener?.('scroll', apply);
    return () => {
        stopWatching();
        viewport?.removeEventListener?.('scroll', apply);
        win.removeEventListener?.('scroll', apply);
        delete doc.documentElement.dataset['keyboardViewport'];
    };
}
