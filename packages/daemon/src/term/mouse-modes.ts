/**
 * DEC mouse-reporting mode state, read out of the byte stream the daemon already parses.
 *
 * Why this lives here rather than in a renderer: `ghostty-web@0.4.0` parses DECSET
 * 9/1000/1002/1003/1005/1006/1015/1016 and then **ignores** them — its canvas handlers drive
 * text selection and `hasMouseTracking()` is never consulted (docs/capabilities/01 §TERM-037,
 * proven by run-I's mouse step). So the port implements mouse reporting in its OWN layer, which
 * means the client needs the modes as state rather than as engine behaviour. Every PTY byte
 * already flows through `@xterm/headless` here, so this is where the modes are known first.
 *
 * Two halves, because the emulator only serves one of them:
 *
 *   - **tracking** (`9` / `1000` / `1002` / `1003`) is `terminal.modes.mouseTrackingMode`,
 *     which xterm maintains and resets on RIS. Read, never re-derived.
 *   - **format** (`1005` / `1006` / `1015` / `1016`) has no `IModes` member at all, so it is
 *     parsed here off `CSI ? … h` / `CSI ? … l` through the parser's own handler registry (not
 *     a second scanner over the bytes — the handler sees exactly the sequences xterm accepted,
 *     multi-parameter forms like `CSI ? 1000 ; 1006 h` included).
 *
 * Semantics are ghostty's, transcribed from `ghostty/src/terminal/stream_terminal.zig:538-541`
 * (`mouse_format_* => flags.mouse_format = if (enabled) .<fmt> else .x10`): setting a format
 * mode selects it, and RESETTING any format mode returns to X10 whether or not that format was
 * the active one. RIS (`ESC c`) clears the format back to X10 as well, matching xterm's own
 * full reset (DECSTR does not — verified against `@xterm/headless` 6.0.0, whose
 * `mouseTrackingMode` also survives a soft reset).
 */

import type { IDisposable, Terminal as HeadlessTerminal } from '@xterm/headless';

/**
 * DEC tracking mode, in xterm's vocabulary (`IModes.mouseTrackingMode`).
 *
 * `x10` = 9 (press only), `vt200` = 1000 (press + release), `drag` = 1002 (+ motion while a
 * button is down), `any` = 1003 (+ all motion). Ghostty calls the last three normal/button/any.
 */
export type MouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any';

/** Coordinate encoding. `x10` is the default (and what resetting any format returns to). */
export type MouseFormat = 'x10' | 'utf8' | 'sgr' | 'urxvt' | 'sgr-pixels';

/** DEC private mode number → the format it selects. */
export const MOUSE_FORMAT_MODES: ReadonlyMap<number, MouseFormat> = new Map<number, MouseFormat>([
    [1005, 'utf8'],
    [1006, 'sgr'],
    [1015, 'urxvt'],
    [1016, 'sgr-pixels']
]);

export const DEFAULT_MOUSE_FORMAT: MouseFormat = 'x10';

/**
 * Fold one DECSET/DECRST into a format.
 *
 * `params` is xterm's parameter list for the sequence — a `number[]` entry is a sub-parameter
 * group (`CSI ? 1006 : 2 h`), whose first member is the mode number. A sequence carrying no
 * format mode leaves the format alone.
 */
export function applyFormatModes(
    current: MouseFormat,
    params: readonly (number | number[])[],
    enabled: boolean
): MouseFormat {
    let next = current;
    for (const param of params) {
        const mode = Array.isArray(param) ? param[0] : param;
        if (mode === undefined) continue;
        const format = MOUSE_FORMAT_MODES.get(mode);
        if (format === undefined) continue;
        // Ghostty's rule verbatim: enabling selects the format, disabling ANY format mode
        // returns to X10 — a program that turns 1006 off while 1005 was never on still lands
        // on X10, which is what `stream_terminal.zig` does.
        next = enabled ? format : DEFAULT_MOUSE_FORMAT;
    }
    return next;
}

export interface MouseFormatTracker {
    readonly format: MouseFormat;
    dispose(): void;
}

/**
 * Watch a headless terminal's format modes. `onChange` fires only on a real transition, so a
 * program that re-asserts `1006` every redraw costs nothing downstream.
 */
export function trackMouseFormat(
    term: HeadlessTerminal,
    onChange?: ((format: MouseFormat) => void) | undefined
): MouseFormatTracker {
    let format: MouseFormat = DEFAULT_MOUSE_FORMAT;
    const disposables: IDisposable[] = [];

    const set = (next: MouseFormat): void => {
        if (next === format) return;
        format = next;
        onChange?.(format);
    };

    // `false` = "not fully handled": xterm's own DECSET/DECRST bookkeeping still runs, so
    // `modes.mouseTrackingMode` (and every other mode) keeps working exactly as before.
    disposables.push(
        term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
            set(applyFormatModes(format, params, true));
            return false;
        })
    );
    disposables.push(
        term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
            set(applyFormatModes(format, params, false));
            return false;
        })
    );
    // RIS. xterm resets `mouseTrackingMode` here; the format is ours to reset.
    disposables.push(
        term.parser.registerEscHandler({ final: 'c' }, () => {
            set(DEFAULT_MOUSE_FORMAT);
            return false;
        })
    );

    return {
        get format(): MouseFormat {
            return format;
        },
        dispose(): void {
            for (const entry of disposables.splice(0)) entry.dispose();
        }
    };
}
