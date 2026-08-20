/**
 * The web-pane priority key layer (WEB-152/WEB-153, TERM-156, SET-188…SET-191).
 *
 * When the focused pane is a web pane, a **hard-coded** browser keymap runs *before* the normal
 * binding lookup, so ⌘L/⌘R/⌘←/⌘→/⌘T/⌘W/⌘⇧[/⌘⇧]/⌘=/⌘-/⌘0 mean what they mean in every browser —
 * and every other pane type keeps the global defaults on those same combos (⌘W closes a pane,
 * ⌘R is unbound, ⌘= is the markdown font size). That is exactly the Swift arrangement
 * (`NexCommands.swift:222-338`), and it is a *layer* rather than eleven default bindings for the
 * reason the Swift comment gives: the defaults must not change for anyone else.
 *
 * The dispatcher's seam is tri-state, and all three states are load-bearing (§7.3):
 *
 *   `true`  — consumed by a web action;
 *   `false` — **deliberately** not consumed: the key falls through to whatever is next, which is
 *             how ⌘← moves the text cursor while the URL bar is being edited, and how ⌘W on a
 *             single-tab pane reaches the normal close-pane binding instead of being swallowed;
 *   `null`  — not applicable (not a web pane, or a combo this table does not claim), so the
 *             normal map runs.
 *
 * Two assignments are deliberate and easy to "fix" wrongly:
 *   - back/forward are ⌘←/⌘→, **not** ⌘[/⌘], so ⌘[/⌘] keep meaning focus-prev/next inside a web
 *     pane (SET-189, Swift issue #229);
 *   - ⌘= and ⌘⇧= both zoom in, because ⌘+ on a US layout is a shifted `=`.
 */

import type { KeyEventLike } from '../chrome';

/** macOS virtual key codes, the same identities `chrome/keys.ts` maps `KeyboardEvent.code` to. */
const KEY = {
    L: 37,
    R: 15,
    T: 17,
    W: 13,
    ArrowLeft: 123,
    ArrowRight: 124,
    BracketLeft: 33,
    BracketRight: 30,
    Equal: 24,
    Minus: 27,
    Zero: 29
} as const;

/** What the layer needs to know about the pane that has focus. */
export interface FocusedWebPane {
    readonly paneID: string;
    /** The active tab, or null for a tab-less pane (a freshly opened, never-navigated one). */
    readonly tabID: string | null;
    readonly tabCount: number;
}

export interface WebPanePriorityDeps {
    /** Null when the focused pane is not a web pane — the layer then declines entirely. */
    focusedWebPane: () => FocusedWebPane | null;
    /**
     * SET-190: the URL bar (or any chrome text field in the pane) has the caret. The Swift test
     * is `firstResponder is NSText`; the DOM equivalent is "an editable element inside this
     * pane's chrome is `document.activeElement`".
     */
    isChromeTextEditing: () => boolean;
    focusURLBar: (paneID: string) => void;
    reload: (paneID: string) => void;
    back: (paneID: string) => void;
    forward: (paneID: string) => void;
    newTab: (paneID: string) => void;
    closeTab: (paneID: string, tabID: string) => void;
    /** ±1 through the tab strip, wrapping. */
    cycleTab: (paneID: string, offset: number) => void;
    zoom: (paneID: string, direction: 'in' | 'out' | 'reset') => void;
}

/** The trigger shape the dispatcher hands over (only `keyCode` matters here). */
export interface PriorityTrigger {
    readonly keyCode: number;
}

export type WebPanePriority = (trigger: PriorityTrigger, event: KeyEventLike) => boolean | null;

function plainCommand(event: KeyEventLike): boolean {
    return event.metaKey && !event.shiftKey && !event.ctrlKey && !event.altKey;
}

function commandShift(event: KeyEventLike): boolean {
    return event.metaKey && event.shiftKey && !event.ctrlKey && !event.altKey;
}

export function createWebPanePriority(deps: WebPanePriorityDeps): WebPanePriority {
    return (trigger, event) => {
        const pane = deps.focusedWebPane();
        if (pane === null) return null;

        const isCommand = plainCommand(event);
        const isCommandShift = commandShift(event);
        if (!isCommand && !isCommandShift) return null;

        switch (trigger.keyCode) {
            case KEY.L:
                if (!isCommand) return null;
                deps.focusURLBar(pane.paneID);
                return true;

            case KEY.R:
                if (!isCommand) return null;
                deps.reload(pane.paneID);
                return true;

            case KEY.ArrowLeft:
                if (!isCommand) return null;
                // Fall through so ⌘← moves the caret rather than navigating back.
                if (deps.isChromeTextEditing()) return false;
                deps.back(pane.paneID);
                return true;

            case KEY.ArrowRight:
                if (!isCommand) return null;
                if (deps.isChromeTextEditing()) return false;
                deps.forward(pane.paneID);
                return true;

            case KEY.T:
                if (!isCommand) return null;
                deps.newTab(pane.paneID);
                return true;

            case KEY.W: {
                if (!isCommand) return null;
                // SET-191: one tab means ⌘W is the *pane's* close, not the tab's. `null` (not
                // `false`) so the normal `close_pane` binding runs.
                if (pane.tabCount <= 1 || pane.tabID === null) return null;
                deps.closeTab(pane.paneID, pane.tabID);
                return true;
            }

            case KEY.BracketLeft:
                if (!isCommandShift) return null;
                if (deps.isChromeTextEditing()) return false;
                deps.cycleTab(pane.paneID, -1);
                return true;

            case KEY.BracketRight:
                if (!isCommandShift) return null;
                if (deps.isChromeTextEditing()) return false;
                deps.cycleTab(pane.paneID, 1);
                return true;

            case KEY.Equal:
                // ⌘= and ⌘⇧= (which is what ⌘+ produces on a US layout) both zoom in.
                deps.zoom(pane.paneID, 'in');
                return true;

            case KEY.Minus:
                if (!isCommand) return null;
                deps.zoom(pane.paneID, 'out');
                return true;

            case KEY.Zero:
                if (!isCommand) return null;
                deps.zoom(pane.paneID, 'reset');
                return true;

            default:
                return null;
        }
    };
}

/** The DOM half of `isChromeTextEditing`: an editable element inside a web pane's chrome. */
export const WEB_CHROME_TEXT_ATTRIBUTE = 'data-web-chrome-text';

export function chromeTextIsFocused(active: unknown): boolean {
    if (active === null || typeof active !== 'object') return false;
    const element = active as { closest?: unknown };
    if (typeof element.closest !== 'function') return false;
    return (element.closest as (selector: string) => unknown)(`[${WEB_CHROME_TEXT_ATTRIBUTE}]`) !== null;
}

// ── chords forwarded from an embedded page ──────────────────────────────────────────

/**
 * `web-chord:<code>[:shift]` — the relay the shell uses when a page swallowed one of our chords
 * (`shell/webhost/keys.ts`). It arrives as an ordinary `menu-command`, so no new message type is
 * owed to the protocol, and it is replayed through the SAME layer a real keystroke takes: the
 * synthesised event carries `metaKey` and the physical `code`, and the layer's own rules (URL-bar
 * deferral, the single-tab ⌘W fall-through) apply unchanged.
 */
export const WEB_CHORD_COMMAND_PREFIX = 'web-chord:';

export function parseChordCommand(command: string): KeyEventLike | null {
    if (!command.startsWith(WEB_CHORD_COMMAND_PREFIX)) return null;
    const [code, modifier] = command.slice(WEB_CHORD_COMMAND_PREFIX.length).split(':');
    if (code === undefined || code === '') return null;
    return {
        code,
        metaKey: true,
        shiftKey: modifier === 'shift',
        ctrlKey: false,
        altKey: false
    };
}

/**
 * Replay a relayed chord as a real `keydown` on `window`.
 *
 * Dispatching the event — rather than calling the priority layer directly — is what makes this
 * path identical to a keystroke: the interceptor's palette guard, the global-hotkey guard, the
 * priority layer AND the normal binding lookup all run in order. ⌘F depends on that last part
 * (it is `toggle_search`, an ordinary binding, not a member of the priority table).
 *
 * It is dispatched at `document` rather than at `window`: the interceptor listens on `window` in
 * the CAPTURE phase, and a capture listener on the propagation *root* only runs for an event
 * whose target is below it. An event dispatched at `window` itself has a one-node path and never
 * reaches it.
 *
 * Returns true when something consumed the chord (`preventDefault`), which is what a caller
 * needs to know to fall back.
 */
export function replayChordCommand(command: string, target?: EventTarget): boolean {
    const chord = parseChordCommand(command);
    if (chord === null) return false;
    const node = target ?? (typeof document === 'undefined' ? null : document.body ?? document);
    if (node === null) return false;
    return !node.dispatchEvent(
        new KeyboardEvent('keydown', {
            code: chord.code,
            metaKey: true,
            shiftKey: chord.shiftKey,
            bubbles: true,
            cancelable: true
        })
    );
}
