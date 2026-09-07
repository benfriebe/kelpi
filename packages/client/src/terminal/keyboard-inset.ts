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
 * ## Why the inset is arithmetic and not padding
 *
 * The pane could shrink its host with a bottom padding and let the `ResizeObserver` notice. It
 * does not, and the reason is measured: the engine sizes its canvas INLINE to
 * `cols x cellWidth` by `rows x cellHeight`
 * (`vendor/ghostty-web-patched/source/lib/renderer.ts:441-446`) and appends it as the host's
 * first child with `display: block`, so an inline height beats the client's own
 * `[data-terminal-host] > * { height: 100% }` rule (`styles.css:424`) and the grid is already
 * top-anchored inside the host. Taking the keyboard off the MEASURED height therefore shrinks the
 * canvas from the bottom exactly as a padding would - the prompt line, which is the bottom row,
 * lands directly above the keyboard - while leaving the host's box, the mouse reporter's origin
 * and the focus ring's inset untouched. It is also the only form the rule can take that a jsdom
 * test can drive, because the pane measures through an injectable seam and jsdom has no layout.
 *
 * ## Why the inset is settled before it is used
 *
 * A software keyboard ANIMATES, and `visualViewport` fires `resize` on most frames while it does
 * (iOS's own transition is roughly 250-300 ms, i.e. on the order of 15 frames). The pane's
 * existing debounce cannot absorb that on its own: it has a ceiling
 * (`RESIZE_MAX_WAIT_MS`, deliberately, so that DRAGGING a divider republishes ~10x/s instead of
 * starving), and a keyboard transition looks exactly like a drag to it. Every one of those
 * republishes is a `resize` on the pane's stream, a `SIGWINCH` on the PTY and a full repaint of
 * whatever TUI is running, for intermediate heights nobody will ever see.
 *
 * So the raw inset is settled HERE, before the pane ever measures with it: a new value is
 * published only once it has stopped changing for {@link PHONE_KEYBOARD_SETTLE_MS}. One settled
 * value per transition, one measurement, one resize message - up and down.
 */

import { useEffect, useState } from 'react';

import {
    defaultFormFactorWindow,
    readSoftKeyboardInset,
    watchSoftKeyboardInset,
    type FormFactorWindow
} from '../chrome/form-factor';

/**
 * How long the visual viewport must hold still before its inset counts as the keyboard's.
 *
 * 120 ms, and the two bounds it sits between are what fix it. The LOWER bound is the gap between
 * the resize events a keyboard animation produces: those arrive per frame, about 16.7 ms apart at
 * 60 Hz, so anything above ~2 frames of quiet cannot be tripped mid-animation and 120 ms is
 * roughly 7. The UPPER bound is what a person waits for after the keyboard has come to rest
 * before the rows change under them; an eighth of a second is below the ~200 ms at which a
 * response stops reading as immediate.
 *
 * Measured by the `phone-keyboard-inset` audit step, which dispatches a frame-cadence burst of
 * `visualViewport` resizes and asserts the pane sends the daemon exactly one `resize` for it.
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

/** The settled keyboard inset in CSS px, as the pane last measured with it. */
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
 * type on. Returning zero instead would trip the pane's zero-size guard, which would send NO
 * resize at all and leave the terminal at its full pre-keyboard rows - the exact defect the inset
 * exists to fix, in the one case where it matters most.
 *
 * `inset <= 0` returns the height untouched, so a desktop pane (whose inset is always 0) takes
 * the identical arithmetic path it took before this function existed.
 */
export function heightUnderKeyboard(height: number, inset: number, cellHeight: number): number {
    if (!(inset > 0)) return height;
    const floor = Math.min(height, cellHeight);
    return Math.max(floor, height - inset);
}

// ── the settle rule ─────────────────────────────────────────────────────────────────

/** A settled inset, and a way to hear about it. Disposable, because it owns a timer. */
export interface SoftKeyboardInsetSource {
    /** The settled inset in CSS px. */
    read(): number;
    /** Called when `read()` would answer differently. Returns an unsubscribe. */
    subscribe(listener: () => void): () => void;
    dispose(): void;
}

/**
 * Watch the visual viewport and publish its inset only once it has stopped moving.
 *
 * Seeded from the CURRENT inset rather than from zero, so a pane that mounts while the keyboard
 * is already up measures itself correctly on its first pass instead of resizing once immediately
 * afterwards.
 *
 * The value published is re-read when the timer fires, not the one that armed it: the point of
 * the rule is the geometry at REST, and the value that armed the timer is by construction an
 * intermediate frame of the animation.
 */
export function createSoftKeyboardInsetSource(
    win: FormFactorWindow,
    settleMs: number = PHONE_KEYBOARD_SETTLE_MS
): SoftKeyboardInsetSource {
    let settled = readSoftKeyboardInset(win);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const listeners = new Set<() => void>();

    const clear = (): void => {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
    };

    const onViewportChange = (): void => {
        clear();
        // Already where we published: a wobble that came back (iOS moves `offsetTop` on scroll
        // and back again) is not a transition, and arming a timer for it would publish the same
        // number and cost a measurement.
        if (readSoftKeyboardInset(win) === settled) return;
        timer = setTimeout(() => {
            timer = null;
            const next = readSoftKeyboardInset(win);
            if (next === settled) return;
            settled = next;
            for (const listener of [...listeners]) listener();
        }, settleMs);
    };

    const stopWatching = watchSoftKeyboardInset(win, onViewportChange);

    return {
        read: () => settled,
        subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        dispose(): void {
            clear();
            stopWatching();
            listeners.clear();
        }
    };
}

/**
 * The settled software-keyboard inset, in CSS px, or 0 when `enabled` is false.
 *
 * `enabled` is the form-factor gate and it is a parameter rather than a read inside, so that a
 * desktop pane subscribes to NOTHING: no viewport listener, no timer, no state. The hook is still
 * called unconditionally (it is a hook), but on a desktop it does nothing at all and returns the
 * constant 0 that `heightUnderKeyboard` treats as "no keyboard".
 */
export function useSettledSoftKeyboardInset(
    enabled: boolean,
    win: FormFactorWindow = defaultFormFactorWindow(),
    settleMs: number = PHONE_KEYBOARD_SETTLE_MS
): number {
    const [inset, setInset] = useState(0);
    useEffect(() => {
        if (!enabled) {
            setInset(0);
            return;
        }
        const source = createSoftKeyboardInsetSource(win, settleMs);
        setInset(source.read());
        const off = source.subscribe(() => setInset(source.read()));
        return () => {
            off();
            source.dispose();
        };
    }, [enabled, win, settleMs]);
    // Belt and braces for the render in which `enabled` flips to false and the effect has not run
    // yet: the answer a desktop pane sees is never a stale phone number.
    return enabled ? inset : 0;
}
