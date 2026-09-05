/**
 * Kitty keyboard protocol negotiation, read out of the byte stream the daemon already parses.
 *
 * Why this lives here rather than in a renderer, and why it looks exactly like
 * `mouse-modes.ts`: the engine will not do it. `ghostty-web 0.4.0-nex.2` registers **one**
 * `keydown` listener and **zero** `keyup` listeners, and its `setKittyFlags` has no call site
 * anywhere in the bundle (../kelpi-docs/capabilities/01 §TERM-030, re-measured on the vendored bundle).
 * A protocol whose whole point is press/repeat/release cannot be implemented by a layer that
 * never sees a release, so the port implements it in its OWN layer — the daemon tracks the
 * negotiated flags off the VT stream (every PTY byte already flows through `@xterm/headless`
 * here, so this is where they are known first), streams them to clients as part of `VtModes`
 * exactly like `mouseTracking`, and the CLIENT encodes the key events itself
 * (`client/src/terminal/kitty-keyboard.ts`).
 *
 * The four negotiation sequences (sw.kovidgoyal.net/kitty/keyboard-protocol):
 *
 *   `CSI > flags u`        push the current flags onto this screen's stack, set them to `flags`
 *   `CSI < number u`       pop `number` entries (default 1), restoring the flags under them
 *   `CSI = flags ; mode u` set the flags in place (mode 1 replace, 2 or-in, 3 clear); no stack
 *   `CSI ? u`              query — the terminal must REPLY `CSI ? flags u` **to the PTY**
 *
 * The reply is the load-bearing one: it is how an application discovers the protocol exists at
 * all (a terminal without support answers nothing), and — because the value it reports is what
 * was actually stored — it is also how the application discovers WHICH enhancements this
 * terminal supports. That is the spec's progressive-enhancement contract, and this module
 * honours it by masking every incoming value with `SUPPORTED_KITTY_FLAGS` before storing it: a
 * program that asks for all five bits and then queries is told `11`, and encodes accordingly.
 * Advertising a bit the client's encoder cannot honour exactly would be worse than not
 * advertising it — see `client/src/terminal/kitty-keyboard.ts` for why `report alternate keys`
 * and `report associated text` are not in the supported set.
 *
 * **Per-screen stacks.** The spec gives the alternate screen its own stack so a full-screen
 * application that sets flags and dies without popping cannot leave the shell underneath it in
 * a protocol the shell never asked for. `@xterm/headless` exposes the switch
 * (`buffer.onBufferChange`, `buffer.active.type`), so the port implements it rather than
 * documenting a divergence: two independent `{flags, stack}` pairs, and `flags` reads the
 * active one.
 *
 * **Reset.** RIS (`ESC c`) clears both screens' flags and both stacks, which is what a full
 * terminal reset means. A pane respawn needs no rule of its own: the pane's emulator is
 * disposed and rebuilt (`service.ts` `dispose`/`attach`), so a stack cannot outlive the
 * process that pushed it.
 */

import type { IDisposable, Terminal as HeadlessTerminal } from '@xterm/headless';

/** Report `Esc`, `ctrl+key`, `alt+key` and the keypad unambiguously as `CSI … u`. */
export const KITTY_DISAMBIGUATE = 0b1;
/** Report press / repeat / release as the `:1` / `:2` / `:3` event-type sub-parameter. */
export const KITTY_REPORT_EVENT_TYPES = 0b10;
/** Report `unicode-key-code:shifted:base-layout` alternates. NOT supported — see below. */
export const KITTY_REPORT_ALTERNATE_KEYS = 0b100;
/** Report every key as an escape code, text-producing keys included. */
export const KITTY_REPORT_ALL_KEYS = 0b1000;
/** Report the associated text as a third parameter. NOT supported — see below. */
export const KITTY_REPORT_ASSOCIATED_TEXT = 0b10000;

/**
 * The enhancements this port implements **exactly**, and therefore the only bits it will ever
 * store or report back from a query.
 *
 * `report alternate keys` (0b100) and `report associated text` (0b10000) are deliberately
 * absent. Both need a key identity the browser does not hand out: the alternate-keys form wants
 * the *unshifted* codepoint on the current layout and the codepoint of the same physical key on
 * a US layout, and a `KeyboardEvent` carries exactly one produced `key` plus a physical `code`
 * whose meaning is layout-dependent. Deriving the missing identities would mean hard-coding a
 * US layout table — the very assumption PLAN.md decision 14 refuses — so the port declines the
 * bits instead of guessing, and the query reply says so.
 */
export const SUPPORTED_KITTY_FLAGS =
    KITTY_DISAMBIGUATE | KITTY_REPORT_EVENT_TYPES | KITTY_REPORT_ALL_KEYS;

/**
 * Stack depth. The spec requires "at least 16"; the port keeps 32 and, when a push overflows
 * it, discards the OLDEST entry rather than refusing the push — a runaway pusher must not be
 * able to make a later pop restore the wrong flags, and it must not be able to grow memory
 * without bound either.
 */
export const KITTY_STACK_MAX_DEPTH = 32;

/** `CSI = flags ; mode u`'s second parameter. */
export const KITTY_SET_MODE_REPLACE = 1;
export const KITTY_SET_MODE_OR = 2;
export const KITTY_SET_MODE_CLEAR = 3;

/**
 * One `CSI = flags ; mode u` folded into the current value.
 *
 * Mode 1 (and any unknown/absent mode, which defaults to 1) replaces; 2 sets the named bits and
 * keeps the rest; 3 clears the named bits and keeps the rest. Every result is masked, so no
 * unsupported bit can enter the state by any route.
 */
export function applyKittySetMode(current: number, flags: number, mode: number): number {
    const wanted = sanitizeFlags(flags);
    switch (mode) {
        case KITTY_SET_MODE_OR:
            return (sanitizeFlags(current) | wanted) & SUPPORTED_KITTY_FLAGS;
        case KITTY_SET_MODE_CLEAR:
            return sanitizeFlags(current) & ~wanted & SUPPORTED_KITTY_FLAGS;
        default:
            return wanted;
    }
}

/** Mask + guard: anything not a finite non-negative integer reads as "no flags". */
export function sanitizeFlags(value: number): number {
    if (!Number.isFinite(value) || value < 0) return 0;
    return Math.trunc(value) & SUPPORTED_KITTY_FLAGS;
}

/** `CSI ? {flags} u` — the answer a real terminal gives `CSI ? u`, as PTY input bytes. */
export function kittyQueryReply(flags: number): Uint8Array {
    const text = `\u001B[?${String(sanitizeFlags(flags))}u`;
    const out = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) out[index] = text.charCodeAt(index) & 0xff;
    return out;
}

export type KittyScreen = 'normal' | 'alternate';

export interface KittyKeyboardTracker {
    /** The active screen's flags — what the client must encode against right now. */
    readonly flags: number;
    /** Which screen those flags belong to. */
    readonly screen: KittyScreen;
    /** Push depth of one screen's stack (the invariant this module is easiest to break on). */
    stackDepth(screen: KittyScreen): number;
    flagsFor(screen: KittyScreen): number;
    dispose(): void;
}

export interface KittyKeyboardOptions {
    /**
     * Bytes the terminal owes the PTY (today: only the `CSI ? u` reply).
     *
     * Written with the manager's `writeDirect`, never `write`: a device reply answers the
     * application that asked, and mirroring it into every synchronise-input sibling would hand
     * each of them an answer to a question they never asked.
     */
    readonly onReply?: ((reply: Uint8Array) => void) | undefined;
}

interface ScreenState {
    flags: number;
    readonly stack: number[];
}

/** `params[index]`, unwrapping a sub-parameter group (`CSI = 1 : 2 u`) to its first member. */
export function kittyParam(params: readonly (number | number[])[], index: number): number {
    const value = params[index];
    if (value === undefined) return 0;
    const scalar = Array.isArray(value) ? value[0] : value;
    if (scalar === undefined || !Number.isFinite(scalar)) return 0;
    return scalar;
}

/**
 * Watch a headless terminal's kitty-keyboard negotiation.
 *
 * Every handler returns `true` — unlike `mouse-modes.ts`, these sequences are OURS: xterm has
 * no meaning for `CSI > u` / `CSI < u` / `CSI = u`, and letting `CSI ? u` fall through to a
 * future default handler could only produce a second, contradictory answer.
 */
export function trackKittyKeyboard(
    term: HeadlessTerminal,
    options: KittyKeyboardOptions = {}
): KittyKeyboardTracker {
    const screens: Record<KittyScreen, ScreenState> = {
        normal: { flags: 0, stack: [] },
        alternate: { flags: 0, stack: [] }
    };
    let active: KittyScreen = term.buffer.active.type === 'alternate' ? 'alternate' : 'normal';
    const disposables: IDisposable[] = [];

    disposables.push(
        // `CSI > flags u` — push.
        term.parser.registerCsiHandler({ prefix: '>', final: 'u' }, (params) => {
            const state = screens[active];
            state.stack.push(state.flags);
            // Drop the OLDEST, so the most recent 32 pushes still pop back correctly.
            if (state.stack.length > KITTY_STACK_MAX_DEPTH) state.stack.shift();
            state.flags = sanitizeFlags(kittyParam(params, 0));
            return true;
        })
    );
    disposables.push(
        // `CSI < number u` — pop. Absent / zero parameter means one entry.
        term.parser.registerCsiHandler({ prefix: '<', final: 'u' }, (params) => {
            const state = screens[active];
            const requested = kittyParam(params, 0);
            const count = requested > 0 ? Math.trunc(requested) : 1;
            for (let index = 0; index < count; index += 1) {
                const restored = state.stack.pop();
                if (restored === undefined) {
                    // Popping an empty stack resets rather than erroring: an application that
                    // pops more than it pushed must still end up with the protocol off.
                    state.flags = 0;
                    break;
                }
                state.flags = sanitizeFlags(restored);
            }
            return true;
        })
    );
    disposables.push(
        // `CSI = flags ; mode u` — set in place.
        term.parser.registerCsiHandler({ prefix: '=', final: 'u' }, (params) => {
            const state = screens[active];
            const mode = params.length > 1 ? kittyParam(params, 1) : KITTY_SET_MODE_REPLACE;
            state.flags = applyKittySetMode(state.flags, kittyParam(params, 0), mode);
            return true;
        })
    );
    disposables.push(
        // `CSI ? u` — query. Answered even when nothing is set: `CSI ? 0 u` is what tells an
        // application the protocol EXISTS, and silence is what tells it the opposite.
        term.parser.registerCsiHandler({ prefix: '?', final: 'u' }, () => {
            options.onReply?.(kittyQueryReply(screens[active].flags));
            return true;
        })
    );
    disposables.push(
        // RIS. `false` = "not fully handled", so xterm's own full reset still runs.
        term.parser.registerEscHandler({ final: 'c' }, () => {
            for (const screen of [screens.normal, screens.alternate]) {
                screen.flags = 0;
                screen.stack.length = 0;
            }
            return false;
        })
    );
    disposables.push(
        term.buffer.onBufferChange(() => {
            active = term.buffer.active.type === 'alternate' ? 'alternate' : 'normal';
        })
    );

    return {
        get flags(): number {
            return screens[active].flags;
        },
        get screen(): KittyScreen {
            return active;
        },
        stackDepth(screen: KittyScreen): number {
            return screens[screen].stack.length;
        },
        flagsFor(screen: KittyScreen): number {
            return screens[screen].flags;
        },
        dispose(): void {
            for (const entry of disposables.splice(0)) entry.dispose();
        }
    };
}
