/**
 * The chords the PLATFORM owns, stated once for the shell's menu and the client's panes (#95).
 *
 * Spec: docs/terminal-surface.md section 10.2.1 and docs/config-keybindings.md section 7.4.
 *
 * ## What this is for
 *
 * macOS answers ⌘H, ⌥⌘H, ⌘M, ⌃⌘F and ⌘Q from the application menu, and Kelpi's menu carries
 * every one of them as an Electron `role` row whose work happens in Cocoa
 * (`packages/shell/src/menu.ts` ▸ `appMenuTemplate`, plus `{ role: 'windowMenu' }` and the View
 * menu in `packages/shell/src/main.ts`). A native accelerator on a role row fires only when the
 * page did not consume the key first, which is the ordering `menu.ts` relies on throughout.
 *
 * A terminal pane consumed all five. The vendored engine maps `event.code` and then calls
 * `preventDefault()` on anything it mapped (`vendor/ghostty-web-patched/source/lib/
 * input-handler.ts`), and with the kitty keyboard protocol on the pane's own interceptor
 * encoded the chord as `CSI …;9u` and prevented it as well. So ⌘H hid the app from a web pane
 * and did nothing from a terminal, which is #95's report.
 *
 * This module is the one statement of the set. The client's terminal layers ask
 * {@link isPlatformChord} and hand the event back; the shell's app menu builds its rows from
 * {@link PLATFORM_CHORDS} so the two cannot drift apart.
 *
 * ## What is in the set, and what is deliberately not
 *
 * The rule is **the chords macOS assigns to application- and window-level commands**, not
 * "every role row that has an accelerator". Excluded, each for its own reason:
 *
 *   - **⌘Z ⌘X ⌘C ⌘V ⌘A**, the Edit menu's roles. Already handed back one layer up, for a
 *     different reason: they have fallbacks INSIDE the page (the browser's `paste` / `copy`
 *     events, the engine's selection manager), so `isSystemEditingChord` exempts them from the
 *     kitty encoder and #81 binds ⌘C / ⌘V to real Kelpi actions. See terminal-surface.md 10.2.1.
 *   - **⌘R, ⌥⌘R, ⌥⌘I** (Reload, Force Reload, Toggle Developer Tools). Chromium developer
 *     affordances over Kelpi's OWN renderer, not platform conventions: a keystroke typed into a
 *     shell that throws away every piece of view state the window is holding is a hazard, and
 *     Ghostty, the behavioural reference here, has no such rows at all.
 *   - **⌘, and ⌘? / ⌘/** (Settings, Help). Kelpi's own, and they already work from a terminal:
 *     both are dispatched by window-level CAPTURE listeners in `client/src/App.tsx`, which run
 *     before any pane's listeners and consume the event. There is no `role` row behind either.
 *   - **⌘W** (Close). Routed by Kelpi to close a PANE rather than the window (`menu.ts`
 *     ▸ `CLOSE_LABEL`), so it is the app's chord, not the platform's, and it is in the binding
 *     map as `close_pane`.
 *
 * ## Precedence: a user binding wins
 *
 * A chord in this set that the user's map claims stays the app's. Nothing here enforces that,
 * because the ordering already does: the client's dispatcher is a window-level capture listener
 * (`client/src/chrome/keys.ts` ▸ `installKeyDispatcher`) and consumes a bound chord with
 * `preventDefault()` + `stopPropagation()` before any pane's listener runs, so a bound ⌘M never
 * reaches the pane that would otherwise hand it to the platform - and a prevented key is not
 * redispatched to the menu either. An UNBOUND platform chord falls through the dispatcher, the
 * pane declines it, and macOS answers. That is the whole rule, and it is Ghostty's: a keybind is
 * consumed before its key encoder runs.
 *
 * ## No platform branch
 *
 * The matcher reads `metaKey` and never asks which OS it is on. On Windows and Linux `metaKey`
 * is the physical Super/Win key, which those platforms largely own too (Win+M minimises, Win+H
 * is dictation), and Kelpi canonicalises every `super` trigger to `ctrl` off-mac
 * (`./keys.ts` ▸ `canonicalTriggerForPlatform`), so no Kelpi binding can want a `metaKey` chord
 * there. One rule, no branch, nothing to get wrong per platform. The accelerators below are
 * still macOS's, because that is where the role rows are.
 */

import { KEY_NAME_TO_CODE, makeKeyTrigger } from './keys.js';
import type { KeyModifier, KeyTrigger } from './keys.js';

/** The Electron menu `role` that answers each chord. Spelled as Electron spells it. */
export type PlatformChordRole = 'hide' | 'hideOthers' | 'minimize' | 'togglefullscreen' | 'quit';

/** The surface of a `KeyboardEvent` this module reads. Structural, so a test needs no DOM. */
export interface PlatformChordEventLike {
    /** `KeyboardEvent.code`, the PHYSICAL key. Preferred, exactly as the binding layer does. */
    readonly code?: string | undefined;
    /** `KeyboardEvent.key`, consulted only when `code` is absent (synthetic / virtual keyboards). */
    readonly key?: string | undefined;
    readonly shiftKey?: boolean | undefined;
    readonly altKey?: boolean | undefined;
    readonly ctrlKey?: boolean | undefined;
    readonly metaKey?: boolean | undefined;
}

export interface PlatformChord {
    readonly role: PlatformChordRole;
    /** The row's label in the shipped menu, for a log line or a doc table. */
    readonly label: string;
    /**
     * The accelerator Electron gives that role, verbatim, read off a live menu rather than
     * guessed (`harness.menu()` on this Electron: `Command+H`, `Command+Alt+H`,
     * `CommandOrControl+M`, `Control+Command+F`, `CommandOrControl+Q`). Restated here so a
     * test can assert the menu still carries the chord this module hands to it.
     */
    readonly accelerator: string;
    /** `KeyboardEvent.code` of the physical key. */
    readonly code: string;
    /** The lowercased `KeyboardEvent.key` fallback, for an event that carries no `code`. */
    readonly key: string;
    /** ⌥ held. Only Hide Others wants it. */
    readonly alt: boolean;
    /** ⌃ held. Only Toggle Full Screen wants it. */
    readonly ctrl: boolean;
    /** The `⌃⌥⇧⌘` display form (config-keybindings.md section 3.3). */
    readonly display: string;
    /** The config-file trigger, so the binding layer can ask whether a user's map claims it. */
    readonly trigger: KeyTrigger;
}

function chord(
    role: PlatformChordRole,
    label: string,
    accelerator: string,
    code: string,
    key: string,
    keyName: string,
    modifiers: readonly KeyModifier[],
    display: string
): PlatformChord {
    return {
        role,
        label,
        accelerator,
        code,
        key,
        alt: modifiers.includes('alt'),
        ctrl: modifiers.includes('ctrl'),
        display,
        trigger: makeKeyTrigger(KEY_NAME_TO_CODE.get(keyName) ?? -1, modifiers)
    };
}

/**
 * The five, in the order a user meets them in the menu bar (Kelpi ▸ …, then View, then Window).
 *
 * Order is not load-bearing for matching, and IS load-bearing for `appMenuTemplate`, which
 * builds its Hide / Hide Others / Quit rows by filtering this list.
 */
export const PLATFORM_CHORDS: readonly PlatformChord[] = [
    chord('hide', 'Hide Kelpi', 'Command+H', 'KeyH', 'h', 'h', ['super'], '⌘H'),
    chord('hideOthers', 'Hide Others', 'Command+Alt+H', 'KeyH', 'h', 'h', ['alt', 'super'], '⌥⌘H'),
    chord(
        'togglefullscreen',
        'Toggle Full Screen',
        'Control+Command+F',
        'KeyF',
        'f',
        'f',
        ['ctrl', 'super'],
        '⌃⌘F'
    ),
    chord('minimize', 'Minimize', 'CommandOrControl+M', 'KeyM', 'm', 'm', ['super'], '⌘M'),
    chord('quit', 'Quit Kelpi', 'CommandOrControl+Q', 'KeyQ', 'q', 'q', ['super'], '⌘Q')
];

/**
 * The chord this event IS, or null.
 *
 * **Exact modifiers.** ⌘ is required; ⌥ and ⌃ must match the chord's own (so ⌥⌘H is Hide Others
 * and ⌘H is Hide, and neither answers the other); ⇧ is never tolerated, because ⇧⌘M is not
 * Minimize and a terminal should keep encoding it. That is the deliberate difference from
 * `isSystemEditingChord`, which tolerates shift (⌘⇧Z is still Redo) and refuses ctrl and alt
 * outright: these five are named chords with named modifiers rather than a family.
 *
 * **`code` first, `key` as the fallback.** The binding layer matches physical keys
 * (config-keybindings.md section 3, PLAN.md decision 14), so a non-US layout keeps ⌘H on the
 * key labelled H. An event with no `code` at all - a CDP-injected or virtual-keyboard event,
 * the case the vendored engine's own fallback exists for - is matched on the produced `key`.
 */
export function platformChordForEvent(event: PlatformChordEventLike): PlatformChord | null {
    if (event.metaKey !== true) return null;
    if (event.shiftKey === true) return null;
    const alt = event.altKey === true;
    const ctrl = event.ctrlKey === true;
    const code = event.code ?? '';
    const key = (event.key ?? '').toLowerCase();
    for (const candidate of PLATFORM_CHORDS) {
        if (candidate.alt !== alt || candidate.ctrl !== ctrl) continue;
        if (code !== '' ? code === candidate.code : key === candidate.key) return candidate;
    }
    return null;
}

/** Is this event one of the chords the platform owns? */
export function isPlatformChord(event: PlatformChordEventLike): boolean {
    return platformChordForEvent(event) !== null;
}

/** The roles in {@link PLATFORM_CHORDS}, in list order. Used by the shell's menu templates. */
export function platformChordsForRoles(
    roles: readonly PlatformChordRole[]
): readonly PlatformChord[] {
    return PLATFORM_CHORDS.filter((entry) => roles.includes(entry.role));
}
