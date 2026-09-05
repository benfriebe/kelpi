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
 * ## Every modifier crosses, but never a bare key
 *
 * The relay used to carry ⌘ chords only, because the wire format was `web-chord:<code>[:shift]`
 * and the decoder forced `metaKey` true. That left `move_pane_*` (⌃⇧arrow) and the ⌥⌘arrow half
 * of `focus_*_pane` / workspace nav unreachable from a page, with no honest encoding: relaying
 * ⌃⇧← as `web-chord:ArrowLeft:shift` would have replayed ⌘⇧← and navigated the page instead.
 * The format now spells its modifiers out (`chordCommand`), so those chords cross as themselves.
 *
 * What has NOT changed is that a chord must carry ⌘, ⌃ or ⌥ to be taken at all. Shift alone is
 * not a claim - it is how a page's user types a capital letter - and a bare key is the page's by
 * definition. That gate is what keeps the map's one unmodified line (`escape=close_search`) away
 * from every page: stealing Escape would be a far worse defect than the one this module fixes.
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
 * matches on. All four modifiers are carried: ⌘ is no longer implied, because `move_pane_left`
 * (⌃⇧←) does not hold it.
 */
export interface ForwardedChord {
    readonly code: string;
    readonly meta: boolean;
    readonly ctrl: boolean;
    readonly alt: boolean;
    readonly shift: boolean;
}

/** The `menu-command` string the relay carries: `web-chord:<code>[:<modifier>]*`. */
export const WEB_CHORD_COMMAND_PREFIX = 'web-chord:';

/**
 * Encode a chord for the relay, in a form the client's `parseChordCommand` reads back.
 *
 * Two spellings, and the older one is kept deliberately:
 *
 *   - a ⌘ chord with no ⌃/⌥ keeps the original `web-chord:<code>[:shift]`, where ⌘ is implied.
 *     Byte-identical to what this module has always sent, so `CLOSE_PANE_CHORD_COMMAND`
 *     (`client/src/app/shell-close.ts`, the shell Close row's `web-chord:KeyW`) and any other
 *     hand-written constant keep parsing;
 *   - anything else spells every modifier it holds, in a fixed order so the string is stable:
 *     `web-chord:ArrowLeft:ctrl:shift`, `web-chord:ArrowRight:meta:alt`.
 *
 * The decoder tells them apart by looking for `meta`/`ctrl`/`alt` among the tokens: present means
 * the list is authoritative, absent means the legacy form and ⌘. That is why the explicit form
 * always names `meta` when it is held - dropping it would make ⌘⇧D indistinguishable from ⌃⇧D.
 */
export function chordCommand(chord: ForwardedChord): string {
    const legacy = chord.meta && !chord.ctrl && !chord.alt;
    const parts = legacy
        ? chord.shift
            ? ['shift']
            : []
        : [
              ...(chord.meta ? ['meta'] : []),
              ...(chord.ctrl ? ['ctrl'] : []),
              ...(chord.alt ? ['alt'] : []),
              ...(chord.shift ? ['shift'] : [])
          ];
    return [`${WEB_CHORD_COMMAND_PREFIX}${chord.code}`, ...parts].join(':');
}

/** How the log line and any diagnostic names a chord: `⌃⇧ArrowLeft`, `⌘KeyD`. */
export function chordLabel(chord: ForwardedChord): string {
    return `${chord.ctrl ? '⌃' : ''}${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${chord.meta ? '⌘' : ''}${chord.code}`;
}

/** The modifier set a chord holds, in one shape for both the set and the incoming event. */
interface ChordModifiers {
    readonly meta: boolean;
    readonly ctrl: boolean;
    readonly alt: boolean;
    readonly shift: boolean;
}

/**
 * A chord's identity in the claimed set: every modifier it holds, then the physical key.
 *
 * Spelled in full rather than leaving ⌘ implied, because ⌘ is no longer the only modifier that
 * crosses. Fixed order (`MODIFIER_ORDER`'s), so a key built from a config trigger and one built
 * from a keystroke are the same string. Per exact modifier set, so the claim is precisely what
 * the map says: ⇧⌘F is not `toggle_search` and stays with the page, ⇧⌘D is `split_down` and does
 * not.
 */
function chordKey(code: string, modifiers: ChordModifiers): string {
    return `${modifiers.ctrl ? 'ctrl+' : ''}${modifiers.alt ? 'alt+' : ''}${modifiers.shift ? 'shift+' : ''}${modifiers.meta ? 'meta+' : ''}${code}`;
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
    'meta+KeyL', // focus the URL bar
    'meta+KeyR', // reload
    'meta+KeyT', // new tab
    'meta+KeyW', // close tab (falls through to close_pane on the last one)
    'meta+ArrowLeft', // back
    'meta+ArrowRight', // forward
    'shift+meta+BracketLeft', // previous tab
    'shift+meta+BracketRight', // next tab
    'meta+Equal',
    'shift+meta+Equal',
    'meta+Minus',
    'meta+Digit0'
];

/** Settings and Help: their own window listeners in the client, no `KelpiAction` behind them. */
const WINDOW_LISTENER_CHORDS: readonly string[] = ['meta+Comma', 'meta+Slash', 'shift+meta+Slash'];

/**
 * A trigger's chord key, or null when this boundary will not carry it.
 *
 * One rule: at least one of ⌘/⌃/⌥. Shift alone is how a page's user types a capital, and a bare
 * key is the page's by definition - see the module header on why `escape=close_search` must not
 * cross.
 */
function relayableChordKey(trigger: KeyTrigger): string | null {
    const held = new Set<string>(trigger.modifiers);
    const modifiers = {
        meta: held.has('super'),
        ctrl: held.has('ctrl'),
        alt: held.has('alt'),
        shift: held.has('shift')
    };
    if (!modifiers.meta && !modifiers.ctrl && !modifiers.alt) return null;
    const code = domCodeForKeyCode(trigger.keyCode);
    if (code === null) return null;
    return chordKey(code, modifiers);
}

/**
 * The chords to take from a page, for one resolved binding map.
 *
 * Deliberately a pure function of the map plus the two literals above: the whole point of issue
 * #33 is that this answer follows the user's config rather than a hardcoded list, and the only
 * way to keep that true is for the set to have no other input.
 *
 * There is no subtraction any more. Bare ⌘[ / ⌘] used to be carved out on the grounds that
 * "inside a page they are back/forward, which the page may itself want" - which is wrong twice
 * over. config-keybindings.md 7.3 settles it: "back/forward are ⌘←/⌘→, NOT ⌘[/⌘], so ⌘[/⌘] keep
 * meaning focus-previous/next-pane even inside a web pane" (issue #229), and 6 lists both as
 * unconditional. And nothing implements ⌘[ as back in an embedded `WebContentsView` anyway:
 * there is no browser chrome to do it, which is exactly why the priority layer has to call the
 * host's own `back`/`forward` verbs for ⌘←/⌘→. So the carve-out did not hand those keys to the
 * page, it dropped them on the floor.
 */
export function claimedChords(bindings: KeyBindingMap): ReadonlySet<string> {
    const claimed = new Set<string>([...PRIORITY_LAYER_CHORDS, ...WINDOW_LISTENER_CHORDS]);
    for (const binding of bindings.values()) {
        const key = relayableChordKey(binding.trigger);
        if (key !== null) claimed.add(key);
    }
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
 *   - at least one of ⌘/⌃/⌥ (see the module header: shift alone and bare keys are the page's);
 *   - the exact (key + modifiers) pair is claimed by the set above.
 *
 * `claimed` is a parameter only so the set can be tested without module state; callers pass
 * nothing and get the live one.
 */
export function forwardedChord(input: ChordInput, claimed: ReadonlySet<string> = forwarded): ForwardedChord | null {
    if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return null;
    const chord = {
        code: input.code,
        meta: input.meta,
        ctrl: input.control,
        alt: input.alt,
        shift: input.shift
    };
    if (!chord.meta && !chord.ctrl && !chord.alt) return null;
    if (!claimed.has(chordKey(chord.code, chord))) return null;
    return chord;
}
