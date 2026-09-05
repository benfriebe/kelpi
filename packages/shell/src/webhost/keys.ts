/**
 * Browser-shortcut forwarding from an embedded page back to Kelpi's own window.
 *
 * The problem this solves is structural to the port, and it has no equivalent in the Swift app.
 * There, a web pane is a `WKWebView` *inside* the app's window, and `KelpiCommands`' NSEvent
 * monitor sees ⌘F / ⌘L / ⌘T before the web view ever does. Here the page lives in a
 * `WebContentsView` — a **separate renderer with its own keyboard focus** — so the moment a user
 * clicks the page, every chord goes to the page and Kelpi's renderer never sees a keystroke. The
 * whole priority key layer (WEB-152/TERM-156) would be dead the instant it was needed.
 *
 * So the host intercepts exactly the chords Kelpi claims, cancels them in the page, and replays
 * them into the shell window's own renderer - which is where they are implemented. Everything
 * else (⌘C, ⌘A, typing, the page's own shortcuts) is left completely alone: a page that binds
 * ⌘K for its command palette keeps it.
 *
 * ## Why the set is derived rather than listed (issue #33)
 *
 * It used to be a hardcoded twelve-key literal: the web priority table plus ⌘F. That set served
 * the priority layer correctly and was never the thing that also had to carry the **ordinary
 * binding map** across the process boundary - so ⌘D never split, ⌘W never closed, ⇧⌘N never made
 * a scratchpad, and ⌘P reached Chromium's print dialog instead of Kelpi's palette, which meant
 * the palette was not a workaround either. A literal is wrong in principle as well: every one of
 * those is a `keybind` line a user can move, and a hardcoded physical key cannot move with it.
 *
 * The fix already existed one process boundary over. A content pane's markdown/diff preview is a
 * cross-origin iframe with the identical problem, and H9 solved it by handing the frame the
 * whole binding map, derived live (`client/src/content/bridge.ts` ▸ `chordKeysForBindings`).
 * This is the same treatment: `claimedChords` turns the resolved map into the set, the daemon's
 * `keybind` lines feed it (`./client.ts` → `./index.ts` → `setForwardedKeybindLines`), and a
 * rebound action moves with the rebinding. It is also the reason nothing the page owns can be
 * stolen by accident: a chord Kelpi does not claim is not in the map, so it is not in the set.
 *
 * ## What the map alone does not say
 *
 * Three additions and one subtraction, all of them carve-outs the literal encoded and a naive
 * derivation would lose:
 *
 *   - **the priority layer** (§7.3, `client/src/webpane/priority.ts`) is a hardcoded browser
 *     keymap that runs BEFORE the binding lookup, so ⌘L / ⌘R / ⌘T / ⌘← / ⌘→ / ⌘⇧[ / ⌘⇧] / the
 *     zoom trio mean what they mean in every browser. Most of those are in no `keybind` line at
 *     all, so they are listed here - the one place in this module a literal is still right,
 *     because it mirrors a literal the client also holds;
 *   - **⌘, and ⌘/ ⌘?** open Settings and Help through their own window listeners rather than
 *     through the binding map (they are OS menu-bar items in the Swift app, and there is no
 *     `KelpiAction` for either). The content-pane set folds them in for exactly this reason;
 *   - **bare ⌘[ / ⌘]** are subtracted even though the map binds them (`focus_previous_pane` /
 *     `focus_next_pane`): inside a page they are back/forward, which the page may itself want
 *     (SET-189). Only ⌘⇧[ / ⌘⇧] - tab cycling - are Kelpi's.
 *
 * ## The native menu gets there first, for sixteen of them (#47)
 *
 * `../menu.ts` derives the application menu's accelerators from the same binding map, and a
 * native menu accelerator outranks the page: for the 16 `MENU_BAR_ACTIONS` (⌘N, ⌘O, ⌘⇧O, ⌘⇧G,
 * ⌘P, ⌘1-9, ⌘⇧S, ⌘I) the keystroke is taken by the menu and never reaches `before-input-event`,
 * so the relay never sees it. Those chords stay in the set anyway, and it is not redundancy for
 * its own sake: #47 gives an action NO accelerator when it is unbound or when its first trigger
 * has no Electron spelling, and says such an action "still fires through the client dispatcher".
 * From a focused page this relay IS that dispatcher's only route, so the set is the fallback for
 * exactly the cases the menu declines. Narrowing it to "everything except the menu-bar actions"
 * would re-open #33 for those cases and put a second literal back.
 *
 * ## Why only ⌘ chords cross
 *
 * The relay's wire format is `web-chord:<code>[:shift]` and the client decodes it with
 * `metaKey` forced true and ⌃/⌥ forced false (`client/src/webpane/priority.ts` ▸
 * `parseChordCommand`), so a chord carrying ⌃ or ⌥ has no faithful encoding: relaying
 * `ctrl+shift+left` (`move_pane_left`) as `web-chord:ArrowLeft:shift` would replay ⌘⇧← and
 * navigate the page back. Those triggers are therefore refused rather than mistranslated, and
 * the same rule keeps the page safe from the map's one unmodified line (`escape=close_search`) -
 * stealing bare Escape from every page would be a far worse defect than the one this fixes.
 * Widening the relay to ⌃/⌥ needs the decoder on the other side to grow first.
 */

import {
    DEFAULT_KEYBINDINGS,
    parseKeybindValue,
    resolveKeyBindings,
    type KeyBindingMap,
    type KeyTrigger
} from '@kelpi/core/config';

import { domCodeForKeyCode } from './key-codes.js';

/** The subset of Electron's `Input` shape this module reads. */
export interface ChordInput {
    readonly type: string;
    readonly key: string;
    readonly code: string;
    readonly meta: boolean;
    readonly shift: boolean;
    readonly control: boolean;
    readonly alt: boolean;
    readonly isAutoRepeat?: boolean | undefined;
}

/**
 * A chord to replay in Kelpi's own window.
 *
 * `code` is the physical key (`KeyboardEvent.code`), which is what the client's dispatcher
 * matches on; `shift` is the only modifier that varies, because ⌘ is required by construction
 * and ⌃/⌥ are refused.
 */
export interface ForwardedChord {
    readonly code: string;
    readonly shift: boolean;
}

/** The `menu-command` string the relay carries: `web-chord:<code>` or `web-chord:<code>:shift`. */
export const WEB_CHORD_COMMAND_PREFIX = 'web-chord:';

export function chordCommand(chord: ForwardedChord): string {
    return `${WEB_CHORD_COMMAND_PREFIX}${chord.code}${chord.shift ? ':shift' : ''}`;
}

/**
 * A chord's identity in the claimed set: the physical key, prefixed when shift is part of it.
 *
 * Per (key, shift) rather than per key, so the set says precisely what the map says. ⌘⇧F is not
 * `toggle_search` and is left to the page; ⌘⇧D is `split_down` and is taken.
 */
function chordKey(code: string, shift: boolean): string {
    return shift ? `shift+${code}` : code;
}

/**
 * §7.3's hardcoded browser keymap, restated as chord keys.
 *
 * It is not in the binding map - it is a *layer* that runs ahead of the map, deliberately, so
 * the defaults do not change for every other pane type - so nothing derived from the map can
 * find it. `Equal` appears with and without shift because ⌘+ on a US layout is a shifted `=`
 * and the layer zooms in for both.
 */
const PRIORITY_LAYER_CHORDS: readonly string[] = [
    'KeyL', // focus the URL bar
    'KeyR', // reload
    'KeyT', // new tab
    'KeyW', // close tab (falls through to close_pane on the last one)
    'ArrowLeft', // back
    'ArrowRight', // forward
    'shift+BracketLeft', // previous tab
    'shift+BracketRight', // next tab
    'Equal',
    'shift+Equal',
    'Minus',
    'Digit0'
];

/** Settings and Help: their own window listeners in the client, no `KelpiAction` behind them. */
const WINDOW_LISTENER_CHORDS: readonly string[] = ['Comma', 'Slash', 'shift+Slash'];

/**
 * SET-189: bare ⌘[ / ⌘] belong to the page even though the map binds them to focus prev/next.
 * Subtracted last, so neither the map nor a future addition can put them back.
 */
const PAGE_OWNED_CHORDS: readonly string[] = ['BracketLeft', 'BracketRight'];

/**
 * A trigger's chord key, or null when the relay cannot carry it faithfully.
 *
 * ⌘ exactly, optionally with ⇧, and nothing else - see the module header on why ⌃/⌥ and the
 * unmodified lines are refused rather than approximated.
 */
function relayableChordKey(trigger: KeyTrigger): string | null {
    const modifiers = new Set<string>(trigger.modifiers);
    if (!modifiers.has('super') || modifiers.has('ctrl') || modifiers.has('alt')) return null;
    const code = domCodeForKeyCode(trigger.keyCode);
    if (code === null) return null;
    return chordKey(code, modifiers.has('shift'));
}

/**
 * The chords to take from a page, for one resolved binding map.
 *
 * Deliberately a pure function of the map: the whole point of issue #33 is that this answer
 * follows the user's config rather than a literal, and the only way to keep that true is for
 * the set to have no other input.
 */
export function claimedChords(bindings: KeyBindingMap): ReadonlySet<string> {
    const claimed = new Set<string>([...PRIORITY_LAYER_CHORDS, ...WINDOW_LISTENER_CHORDS]);
    for (const binding of bindings.values()) {
        const key = relayableChordKey(binding.trigger);
        if (key !== null) claimed.add(key);
    }
    for (const key of PAGE_OWNED_CHORDS) claimed.delete(key);
    return claimed;
}

/**
 * `keybind` line VALUES (`"super+d=split_right"`) → the claimed set.
 *
 * The same two-step the client's `keyBindingsFromOverrideLines` runs, and for the same reason:
 * an unparseable line is dropped rather than fatal, so one typo in the config file cannot cost
 * the user every other chord (`KeybindingService.loadFromDisk`).
 *
 * NOT canonicalized for the platform (`canonicalKeyBindingsForPlatform`). The relay speaks ⌘
 * end to end - the wire format forces `metaKey`, and the priority layer it serves is a browser
 * keymap - so on a Ctrl-primary platform the honest answer is the set as written, which is what
 * this path already delivered before the set was derived.
 */
export function claimedChordsForLines(lines: readonly string[]): ReadonlySet<string> {
    const overrides = lines
        .map((line) => parseKeybindValue(line))
        .filter((override): override is NonNullable<typeof override> => override !== null);
    return claimedChords(overrides.length === 0 ? DEFAULT_KEYBINDINGS : resolveKeyBindings(overrides));
}

/**
 * The live set, module state - like `./scripts.ts`'s find palette, and for the same reason.
 *
 * The decision itself is taken inside `./tab.ts`'s `before-input-event` handler, one per view,
 * and threading a set through every tab would be a lot of wiring for a single-process fact that
 * is the same for all of them. It starts at the shipped defaults so a view created before the
 * daemon has said anything still forwards the standard chords, and `./index.ts` replaces it on
 * the handshake and on every `settings-changed`.
 */
let forwarded: ReadonlySet<string> = claimedChords(DEFAULT_KEYBINDINGS);

/** Apply the daemon's `keybind` lines. Called on `welcome` and on every `settings-changed`. */
export function setForwardedKeybindLines(lines: readonly string[]): void {
    forwarded = claimedChordsForLines(lines);
}

/** The live set, for diagnostics and tests. */
export function forwardedChordKeys(): ReadonlySet<string> {
    return forwarded;
}

/**
 * Should this keystroke be taken from the page and given to Kelpi?
 *
 * Rules, in order:
 *   - key-downs only (a forwarded key-up would double-fire the binding);
 *   - ⌘ held, and neither ⌃ nor ⌥ - the relay cannot encode those, and every chord that carries
 *     one is the page's as far as this boundary is concerned;
 *   - the (key, shift) pair is claimed by the set above.
 *
 * `claimed` is a parameter only so the set can be tested without module state; callers pass
 * nothing and get the live one.
 */
export function forwardedChord(input: ChordInput, claimed: ReadonlySet<string> = forwarded): ForwardedChord | null {
    if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return null;
    if (!input.meta || input.control || input.alt) return null;
    if (!claimed.has(chordKey(input.code, input.shift))) return null;
    return { code: input.code, shift: input.shift };
}
