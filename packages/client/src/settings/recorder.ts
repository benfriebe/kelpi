/**
 * The key recorder (config-keybindings.md §13.2), as a pure function over one keydown.
 *
 * The sheet in the Swift app captures the next key-down and applies two rules:
 *
 *   1. **Acceptance** — the combo must carry ≥1 modifier, UNLESS the key is Escape or an
 *      F-key (F1–F12), which are accepted bare.
 *   2. **Conflict** (§8.5) — if the trigger already belongs to a DIFFERENT action, the sheet
 *      stays open showing `Already bound to "X"`; if it is the configured GLOBAL hotkey it
 *      stays open showing `Already bound to the global hotkey`. Both messages are the Swift
 *      `KeybindingConflict.message` strings verbatim (`Nex/Models/KeyBinding.swift:416-453`),
 *      and both leave the recorder armed so the user can press another combo. Re-recording an
 *      action's own combo is a silent no-op commit.
 *
 * The global half needs the trigger passed in (`globalHotkey`) because it does not live in the
 * binding map: it is a `global-hotkey = …` line the shell registers with the OS. Passing it is
 * what stops the recorder handing an action a combo the OS will swallow before the app ever
 * sees it — the same trap `KeyRecorderSheet` avoided by taking `globalHotkey:`. The GLOBAL
 * recorder passes nothing (SET-093's `ignoreGlobalHotkey: true`), so re-recording the hotkey
 * you already have is a no-op rather than a self-collision.
 *
 * One deliberate difference, and it is the reason bare Escape is unreachable here: the sheet's
 * Cancel is the standard cancel action, so Escape closes the recorder. A user who wants
 * `escape=close_search` (the shipped default) or any other bare-Escape binding still has the
 * config file — the recorder simply cannot express it, exactly as in the Swift app.
 *
 * Nothing in this module touches the DOM or the socket: it takes a `KeyEventLike` (the same
 * shape `chrome/keys.ts` dispatches on, so a test can drive it with a literal) and returns what
 * the UI should do.
 */

import {
    keyTriggerConfigString,
    keyTriggerDisplayString,
    parseKeyTrigger,
    type KeyBindingMap,
    type KeyTrigger,
    type KelpiAction
} from '@kelpi/core/config';

import { actionForTrigger, modifiersFromEvent, triggerFromEvent, type KeyEventLike } from '../chrome';
import { actionLabel } from './catalog';

/** Two triggers are the same combo when their key and their modifier SET match. */
function sameTrigger(a: KeyTrigger, b: KeyTrigger): boolean {
    return keyTriggerConfigString(a) === keyTriggerConfigString(b);
}

/** F1–F12 are accepted without a modifier (§13.2). */
const FUNCTION_KEY = /^F([1-9]|1[0-2])$/;

export type RecorderOutcome =
    /** Escape (no modifiers): close without change. */
    | { readonly kind: 'cancelled' }
    /** A bare modifier press, or a physical key with no config-file name — keep waiting. */
    | { readonly kind: 'ignored' }
    /** Captured, but refused; the sheet stays open with this message in red. */
    | { readonly kind: 'rejected'; readonly reason: string }
    /**
     * The trigger already belongs to another action, or to the global hotkey (§8.5). The
     * recorder stays open. `action` is the holder, or `null` when the holder is the global
     * hotkey — which is not an action and has no row to jump to.
     */
    | {
          readonly kind: 'conflict';
          readonly reason: string;
          readonly trigger: KeyTrigger;
          readonly action: KelpiAction | null;
      }
    /** Commit: bind `config` to the action being recorded, then close. */
    | {
          readonly kind: 'captured';
          readonly trigger: KeyTrigger;
          readonly config: string;
          readonly display: string;
          /** True when the user re-recorded the action's own combo (a no-op commit, §13.2). */
          readonly unchanged: boolean;
      };

export interface RecorderOptions {
    /** The map to check conflicts against — the daemon's resolved bindings. */
    readonly bindings: KeyBindingMap;
    /** The action being recorded; its own triggers are not conflicts. */
    readonly excluding?: KelpiAction | undefined;
    /**
     * The configured global hotkey as its config string (`"ctrl+alt+space"`), when the caller
     * is the ROW recorder. Absent/null = SET-093's `ignoreGlobalHotkey: true`, which is what
     * the global-hotkey recorder itself passes.
     */
    readonly globalHotkey?: string | null | undefined;
}

/** §13.2's message for a combo that carries no modifier. */
export const NEEDS_MODIFIER_MESSAGE = 'Add at least one modifier (⌘, ⌃, ⌥ or ⇧)';

export function conflictMessage(action: KelpiAction): string {
    return `Already bound to “${actionLabel(action)}”`;
}

/** `KeybindingConflict.globalHotkey.message`, verbatim. */
export const GLOBAL_HOTKEY_CONFLICT_MESSAGE = 'Already bound to the global hotkey';

/** One keydown → what the recorder should do. Pure; the caller owns the sheet's state. */
export function recordKeyEvent(event: KeyEventLike, options: RecorderOptions): RecorderOutcome {
    const modifiers = modifiersFromEvent(event);

    // Cancel first: the standard cancel action beats every capture rule.
    if (event.code === 'Escape' && modifiers.length === 0) return { kind: 'cancelled' };

    const trigger = triggerFromEvent(event);
    // A bare ⌘/⌃/⌥/⇧ press, or a key with no config-file name (§3.4's table is the vocabulary
    // the file can store): not a capture, not an error — keep listening.
    if (trigger === null) return { kind: 'ignored' };

    const bare = modifiers.length === 0;
    const exempt = event.code === 'Escape' || FUNCTION_KEY.test(event.code);
    if (bare && !exempt) return { kind: 'rejected', reason: NEEDS_MODIFIER_MESSAGE };

    // The global hotkey is checked FIRST, exactly as `KeybindingConflict.check` orders it: the
    // OS consumes that combo before the app can see it, so binding an action to it would
    // produce a shortcut that silently never fires.
    const globalTrigger =
        typeof options.globalHotkey === 'string' && options.globalHotkey !== ''
            ? parseKeyTrigger(options.globalHotkey)
            : null;
    if (globalTrigger !== null && sameTrigger(globalTrigger, trigger)) {
        return {
            kind: 'conflict',
            reason: GLOBAL_HOTKEY_CONFLICT_MESSAGE,
            trigger,
            action: null
        };
    }

    const owner = actionForTrigger(options.bindings, trigger);
    if (owner !== null && owner !== options.excluding) {
        return { kind: 'conflict', reason: conflictMessage(owner), trigger, action: owner };
    }

    return {
        kind: 'captured',
        trigger,
        config: keyTriggerConfigString(trigger),
        display: keyTriggerDisplayString(trigger),
        unchanged: owner === options.excluding && owner !== null
    };
}
