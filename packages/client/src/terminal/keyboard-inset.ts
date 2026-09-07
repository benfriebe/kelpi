/**
 * The software keyboard, as one terminal pane sees it (C2, docs/MOBILE-PLAN.md §4).
 *
 * **Owner-directed divergence.** There is no Swift phone UI to port - the shipped app is a Mac
 * app - so every rule in this file is the owner's, not a parity reference. `chrome/form-factor.ts`
 * says this once for the whole phone program; it is repeated here because this module is where
 * the terminal's own geometry stops matching the desktop's.
 *
 * ## Who applies the inset (the coordinator's decision of 2026-09-03, MOBILE-PLAN.md §7)
 *
 * The inset from `useSoftKeyboardInset` is applied to a terminal in exactly ONE place:
 * `TerminalPane`, under the phone form factor, through the functions below. Nobody else may:
 *
 *   - the key bar (C1) is rendered IN FLOW at the bottom of the pane, so the terminal host
 *     shrinks by the bar's own height through the pane's existing `ResizeObserver` path and the
 *     two features never have to agree on a number;
 *   - `PhoneShell` (B2) does not subtract the inset for panes;
 *   - overlays that own their layout (the palette and settings sheets, B5) apply it to
 *     themselves, to their own box, and never to a pane.
 *
 * ## The box follows the keyboard; the daemon hears the rest (C6, device round 4)
 *
 * C2 applied the inset as ARITHMETIC on the measured height and never moved the pane's own box.
 * That is enough for the rows - the engine sizes its canvas INLINE to `cols x cellWidth` by
 * `rows x cellHeight` (`vendor/ghostty-web-patched/source/lib/renderer.ts:441-446`) and the grid
 * is top-anchored, so a shorter grid IS a shorter canvas - but it is not enough for anything the
 * pane renders BELOW the terminal. The key bar (C1) sits in flow at the bottom of a pane that is
 * `h-full`, so under C2 it moved for a keyboard only when the BROWSER shrank the layout viewport,
 * and whether Android Chrome does that (and when) is not something the client controls. The
 * owner's device round 4 saw exactly that: on the first keyboard after load the bar stayed behind
 * the keyboard, and later in the same session it rode it.
 *
 * So C6 makes the box the pane's own business. The live inset is applied as a bottom padding on
 * the pane root on EVERY visual-viewport event, at the viewport's own frame rate, in the same
 * task as the event: the host (a flex child, or `height: 100%` when there is no bar) loses
 * exactly those pixels, the bar rides the keyboard's animation, and the terminal's usable height
 * is then simply the box it has - no arithmetic, nothing to keep in step. {@link heightUnderKeyboard}
 * survives as the cap on that padding ({@link keyboardBoxInset}): the box never shrinks below one
 * cell, because a keyboard taller than the pane must still leave a line to type on.
 *
 * ## Why the daemon is told only once the keyboard has come to rest
 *
 * A software keyboard ANIMATES, and `visualViewport` fires `resize` on most frames while it does
 * (iOS's own transition is roughly 250-300 ms, i.e. on the order of 15 frames). The pane's
 * existing debounce cannot absorb that on its own: it has a ceiling
 * (`RESIZE_MAX_WAIT_MS`, deliberately, so that DRAGGING a divider republishes ~10x/s instead of
 * starving), and a keyboard transition looks exactly like a drag to it. Every one of those
 * republishes is a `resize` on the pane's stream, a `SIGWINCH` on the PTY and a full repaint of
 * whatever TUI is running, for intermediate heights nobody will ever see.
 *
 * So {@link PHONE_KEYBOARD_SETTLE_MS} gates WHEN the pane measures, not WHAT it measures: while
 * the keyboard is in flight the pane moves its box and says nothing, and once the viewport has
 * held still for the settle window it measures once and sends one message. One transition, one
 * `resize` - up and down. That the gate is on the measurement rather than on the value is what
 * makes it correct on Android too, where the layout viewport catches up at the END of the
 * animation: the box and the number the daemon is told are read from the same DOM at the same
 * instant, so they can never disagree by a keyboard's height (which a settled VALUE, snapshotted
 * before the layout viewport moved, would).
 */

import {
    readSoftKeyboardInset,
    watchSoftKeyboardInset,
    type FormFactorWindow
} from '../chrome/form-factor';

/**
 * How long the visual viewport must hold still before the pane measures and tells the daemon.
 *
 * 120 ms, and the two bounds it sits between are what fix it. The LOWER bound is the gap between
 * the resize events a keyboard animation produces: those arrive per frame, about 16.7 ms apart at
 * 60 Hz, so anything above ~2 frames of quiet cannot be tripped mid-animation and 120 ms is
 * roughly 7. The UPPER bound is what a person waits for after the keyboard has come to rest
 * before the rows change under them; an eighth of a second is below the ~200 ms at which a
 * response stops reading as immediate.
 *
 * It delays the PTY only. The pane's own box follows the keyboard in the same task as each
 * viewport event (C6), so nothing a person can see waits for this window; what waits is the
 * `SIGWINCH` and the TUI repaint behind it.
 *
 * Measured by the `phone-keyboard-inset` audit step, which dispatches a frame-cadence burst of
 * `visualViewport` resizes, asserts the pane's box tracks every one of them, and asserts the pane
 * sends the daemon exactly one `resize` for the whole burst.
 */
export const PHONE_KEYBOARD_SETTLE_MS = 120;

/**
 * What the engine's hidden `<textarea>` must say to a software keyboard, under the phone form
 * factor only.
 *
 * The first three are what stop a keyboard REWRITING the byte stream: autocapitalisation turns
 * `git` into `Git` at the start of a line, autocorrect replaces a flag or a path with a word, and
 * a spell checker underlines a whole shell session. The engine already sets those three itself on
 * every platform (`vendor/ghostty-web-patched/source/lib/terminal.ts:410-412`), so they are
 * restated rather than introduced - they are listed because the rule is "the terminal asks for a
 * raw keyboard", not "the terminal inherits whatever the engine happened to set".
 *
 * The last two are the phone-only half and the engine sets neither. `inputmode="text"` asks for
 * the full keyboard rather than a numeric or URL variant. `enterkeyhint="send"` labels the return
 * key, which on iOS otherwise reads "return" or "go" depending on what the browser guesses about
 * a form that does not exist here; "send" is the closest of the standard hints to "run this line".
 *
 * MOBILE-PLAN.md §9 names the residual risk this does not remove: a keyboard with predictive text
 * can still commit a suggestion, and the escape hatch there is C1's own input field.
 */
export const PHONE_TEXT_INPUT_ATTRIBUTES: Readonly<Record<string, string | null>> = {
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    inputmode: 'text',
    enterkeyhint: 'send'
};

/**
 * What to undo when a pane leaves the phone form factor without remounting (an iPad that gains a
 * Bluetooth mouse flips `(pointer: coarse)` live, so this is reachable).
 *
 * Only the two attributes this module INTRODUCED are removed. The other three belong to the
 * engine, which sets them on every textarea it creates on every platform; removing them would be
 * this module editing a desktop terminal, which is the one thing the phone program may not do.
 */
export const PHONE_TEXT_INPUT_ATTRIBUTES_CLEARED: Readonly<Record<string, string | null>> = {
    inputmode: null,
    enterkeyhint: null
};

// ── the pane's published phone state ────────────────────────────────────────────────

/**
 * The keyboard inset in CSS px that the pane's BOX is currently shrunk by.
 *
 * Live since C6, and written in the same task as the viewport event that moved it, so the audit
 * can sample it mid-animation and see the box tracking the keyboard rather than jumping to its
 * resting place a settle window later. At rest it is the same number C2 published.
 */
export const KEYBOARD_INSET_ATTRIBUTE = 'data-terminal-keyboard-inset';

/**
 * The rows the pane last sent the daemon. Rows and not cols: the keyboard takes HEIGHT, so rows
 * is the number the rule moves and cols is the number that must not move.
 */
export const TERMINAL_ROWS_ATTRIBUTE = 'data-terminal-rows';

/**
 * How many `resize` messages this pane has put on its stream since it mounted.
 *
 * The whole point of the settle rule is a count, and a count is not visible in a screenshot or in
 * a final size - "one resize" and "nine resizes" end at the same rows. It is incremented on the
 * same line that sends the message, so it is a report of what the daemon was told rather than an
 * inference from what the pane looks like afterwards.
 */
export const TERMINAL_RESIZES_ATTRIBUTE = 'data-terminal-resizes';

/** The three numbers a phone pane publishes for the audit. */
export interface PhoneTerminalState {
    readonly inset: number;
    readonly rows: number;
    readonly resizes: number;
}

/**
 * Publish the pane's phone state onto its root node.
 *
 * Imperative, like the paint-hold attributes beside it, because a settled keyboard transition and
 * every ordinary resize would otherwise cost a React render to move a `data-` attribute.
 *
 * Written ONLY under the phone form factor, and that is the desktop guarantee in its narrowest
 * form: a desktop pane never calls this, so a desktop window's DOM is byte-identical to what it
 * was before C2 (MOBILE-PLAN.md §3, principle 1).
 */
export function publishPhoneTerminalState(root: Element | null, state: PhoneTerminalState): void {
    if (root === null) return;
    root.setAttribute(KEYBOARD_INSET_ATTRIBUTE, String(state.inset));
    root.setAttribute(TERMINAL_ROWS_ATTRIBUTE, String(state.rows));
    root.setAttribute(TERMINAL_RESIZES_ATTRIBUTE, String(state.resizes));
}

/**
 * Publish just the inset, for the per-frame path (C6).
 *
 * The rows and the resize count belong to the daemon's story and move once per transition;
 * the inset belongs to the box's and moves on every animation frame. Splitting them is what
 * keeps a frame's work to one attribute write and no React render at all.
 */
export function publishKeyboardInset(root: Element | null, inset: number): void {
    if (root === null) return;
    root.setAttribute(KEYBOARD_INSET_ATTRIBUTE, String(inset));
}

/** Take the phone state back off a pane that has stopped being a phone. */
export function clearPhoneTerminalState(root: Element | null): void {
    if (root === null) return;
    root.removeAttribute(KEYBOARD_INSET_ATTRIBUTE);
    root.removeAttribute(TERMINAL_ROWS_ATTRIBUTE);
    root.removeAttribute(TERMINAL_RESIZES_ATTRIBUTE);
}

// ── the geometry ────────────────────────────────────────────────────────────────────

/**
 * The height a terminal may use once the keyboard has taken `inset` px off the bottom.
 *
 * Clamped at one cell, never at zero: a keyboard taller than the pane (a split pane on a small
 * phone, where iOS's keyboard is around 300 px of an 844 px window) must still leave a line to
 * type on. Returning zero instead would collapse the host to nothing and trip the pane's
 * zero-size guard, which would send NO resize at all and leave the terminal at its full
 * pre-keyboard rows - the exact defect the inset exists to fix, in the one case where it matters
 * most.
 *
 * `inset <= 0` returns the height untouched, so a desktop pane (whose inset is always 0) takes
 * the identical arithmetic path it took before this function existed.
 */
export function heightUnderKeyboard(height: number, inset: number, cellHeight: number): number {
    if (!(inset > 0)) return height;
    const floor = Math.min(height, cellHeight);
    return Math.max(floor, height - inset);
}

/**
 * The bottom padding a pane may take for a keyboard `inset` px tall (C6).
 *
 * `capacity` is the host's height WITHOUT any keyboard padding, so the answer is the whole
 * keyboard whenever the pane can afford it and the clamp above whenever it cannot. Expressed as
 * the complement of {@link heightUnderKeyboard} rather than as its own `Math.min`, so the box and
 * the height a terminal may use are the same rule stated once.
 */
export function keyboardBoxInset(capacity: number, inset: number, cellHeight: number): number {
    return Math.max(0, capacity - heightUnderKeyboard(capacity, inset, cellHeight));
}

// ── the settle rule ─────────────────────────────────────────────────────────────────

/**
 * A keyboard in motion. Disposable, because it owns a timer and two viewport listeners.
 */
export interface SoftKeyboardMotion {
    /** The inset the last viewport event reported, in CSS px. */
    live(): number;
    /** True between the first frame of a transition and its settle. */
    moving(): boolean;
    dispose(): void;
}

/** What a watcher wants to hear. Both are called with the inset as it stands at that moment. */
export interface SoftKeyboardMotionHandlers {
    /**
     * The viewport moved: a new inset, in the same task as the event that carried it. The box
     * follows this one, so it must do no more work than a style write.
     */
    readonly onMove: (inset: number) => void;
    /**
     * The viewport has held still for the settle window: measure now, once. Called even when the
     * inset ended where it began (an Android transition does exactly that - see below), because
     * what settles is the LAYOUT, and the caller's own unchanged-geometry check is the thing that
     * decides whether the daemon hears about it.
     */
    readonly onSettle: (inset: number) => void;
}

/**
 * Watch the visual viewport: every frame of the animation to `onMove`, one `onSettle` per
 * transition.
 *
 * Seeded from the CURRENT inset and silent about it: a pane that mounts while the keyboard is
 * already up reads {@link SoftKeyboardMotion.live} and applies it on its first pass, rather than
 * being told about a "transition" that never happened.
 *
 * The timer is armed by a CHANGE and left alone by a repeat, so the settle window means "120 ms
 * with the inset where it is" and a stream of identical readings (iOS fires `scroll` freely)
 * cannot hold it open. `onSettle` re-reads rather than replaying the value that armed it: the
 * point of the rule is the geometry at REST, and the arming value is by construction an
 * intermediate frame.
 *
 * The two shapes this has to be right for, both measured in `TerminalPane.keyboard.test.tsx`:
 *
 *   - iOS: the layout viewport never moves, so the inset climbs 0 -> 300 over the animation and
 *     stays there. Fifteen moves, one settle at 300.
 *   - Android: the layout viewport catches up at the END, so the inset climbs 0 -> 300 over the
 *     animation and then drops back to 0 in one step as `innerHeight` shrinks by the same 300.
 *     Sixteen moves, one settle at 0 - and the box, which followed every one of them, is exactly
 *     where it should be, because the padding came off in the same frame the window shrank.
 */
export function watchSoftKeyboardMotion(
    win: FormFactorWindow,
    handlers: SoftKeyboardMotionHandlers,
    settleMs: number = PHONE_KEYBOARD_SETTLE_MS
): SoftKeyboardMotion {
    let live = readSoftKeyboardInset(win);
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clear = (): void => {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
    };

    const onViewportChange = (): void => {
        const next = readSoftKeyboardInset(win);
        // A repeat is not a frame of anything: iOS fires `scroll` on the visual viewport without
        // moving it, and re-arming for those would push the settle out indefinitely.
        if (next === live) return;
        live = next;
        clear();
        timer = setTimeout(() => {
            timer = null;
            handlers.onSettle(readSoftKeyboardInset(win));
        }, settleMs);
        handlers.onMove(next);
    };

    const stopWatching = watchSoftKeyboardInset(win, onViewportChange);

    return {
        live: () => live,
        moving: () => timer !== null,
        dispose(): void {
            clear();
            stopWatching();
        }
    };
}
