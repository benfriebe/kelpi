/**
 * §TERM-046 — OSC 52, the sequence a program in a pane uses to drive the clipboard.
 *
 * `ESC ] 52 ; <Pc> ; <Pd> BEL|ST`. `Pc` names a selection, `Pd` is either base64 for the
 * terminal to PUT on the clipboard or the single byte `?`, which asks the terminal to send the
 * clipboard's current contents back down the PTY.
 *
 * This module is a parser only. It decides what a sequence *is*; the gate, the log lines and the
 * broadcast are `handlers/app/clipboard.ts`, for the same reason `osc-notify.ts` leaves the
 * suppression matrix to `handlers/app/osc-notifications.ts` — a decision buried in a parser is a
 * decision nobody can exercise. It sits on the headless VT beside OSC 7 / OSC 9 / OSC 777
 * (`term/service.ts`) rather than in a scanner over the raw bytes, so a sequence split across
 * two PTY reads is reassembled by the emulator's own parser instead of missed.
 *
 * ## The posture, and where it diverges from the baseline
 *
 * The shipped macOS app honours OSC 52 **unconditionally and in both directions**:
 * `GhosttyApp.swift:114-123` clears the general pasteboard and sets the string for every write
 * ghostty raises, and `confirm_read_clipboard_cb` (`:106-112`) auto-confirms every read
 * ("Kelpi never shows a paste-confirmation dialog", terminal-surface.md §12.2). ghostty's own
 * defaults are `clipboard-write = allow` / `clipboard-read = ask`, and the Swift app answers the
 * ask with yes.
 *
 * This port is **stricter than the baseline, deliberately**:
 *
 *   - **Reads are refused outright.** There is no config key that turns them on. A terminal that
 *     answers `OSC 52 ; c ; ?` hands whatever the developer last copied — a password, a token, a
 *     private key — to whatever is running in the pane, and in this architecture "whatever is
 *     running in the pane" can be an agent, a `ssh` session on another machine, or a `cat` of a
 *     file someone else wrote. Nothing is written back to the PTY: the refusal is silence plus a
 *     log line, never a reply. (terminal-surface.md §12's port target asks for "appropriate
 *     consent rules"; for reads the only consent rule that survives a multi-client daemon whose
 *     clipboard lives on a *different machine* from the PTY is "no".)
 *   - **Writes are gated on `clipboard-write`, which defaults to FALSE.** Off, a write is dropped
 *     with one log line naming the setting. On, the text crosses to the attached clients and the
 *     client machine's clipboard takes it.
 *
 * ## Grammar, transcribed from ghostty rather than from xterm's docs
 *
 * `ghostty/src/terminal/osc/parsers/clipboard_operation.zig` is the authority this port matches:
 *
 *   - the selection field is **exactly one byte, or empty**. `52;c;<b64>` and `52;;<b64>` are
 *     both the clipboard (ghostty substitutes `'c'` for an empty field, and its own test
 *     `"OSC 52: get/set clipboard (optional parameter)"` pins that); a longer field
 *     (`52;cs;…`, xterm's multi-selection form) is **invalid**, not a set.
 *   - `Pd` of exactly `?` is a read (`data.len == 1 and data[0] == '?'`).
 *
 * Where this port then declines what ghostty accepts, and why:
 *
 *   - ghostty maps **every** other selection byte onto the system clipboard (`else => .standard`,
 *     `stream_handler.zig:1049-1054`), so `p` and `s` write it too. Here they are ignored with a
 *     log: on a machine with no X11 primary selection the only honest answer to "put this on the
 *     primary selection" is "there isn't one", and silently redirecting it to the clipboard is
 *     how a program that meant to touch a scratch buffer overwrites what the user copied.
 *   - an **empty payload** (`52;c;`) is a clipboard *clear* in ghostty. Ignored here: a remote
 *     wiping the developer's clipboard is a destructive write with no content to attribute, and
 *     the whole point of the byte count in the log is that a write can be attributed.
 */

/** The OSC identifier this module claims. */
export const OSC_52_CODE = 52;

/**
 * Largest clipboard write accepted, in DECODED bytes.
 *
 * A PTY is an untrusted byte source: `cat` of a binary file can produce a well-formed OSC 52
 * whose payload is the whole file, and every byte would cross the WebSocket and land in the
 * system clipboard. 100 KiB is far above any real copy (ghostty caps its OSC buffer for the same
 * reason) and far below "a megabyte per frame". Over-cap is DROPPED rather than truncated —
 * unlike a notification, half a clipboard payload is not a degraded version of the thing, it is
 * a different thing, and pasting it would be worse than pasting nothing.
 */
export const OSC_52_MAX_DECODED_BYTES = 100 * 1024;

/**
 * The encoded length that cannot possibly decode under the cap, so a pathological payload is
 * rejected before it is decoded (4 base64 characters per 3 bytes, plus padding).
 */
export const OSC_52_MAX_ENCODED_LENGTH = Math.ceil(OSC_52_MAX_DECODED_BYTES / 3) * 4 + 4;

/** Why a sequence was neither a write nor a read this port will act on. */
export type Osc52IgnoreReason =
    /** Not `Pc ; Pd` at all (no `;`, or a multi-byte selection field). */
    | 'malformed'
    /** A selection this port does not honour (`p`, `s`, `q`, …). */
    | 'selection'
    /** `Pd` is not base64. */
    | 'not-base64'
    /** Decoded payload over `OSC_52_MAX_DECODED_BYTES`. */
    | 'too-large'
    /** A zero-length write — ghostty's clipboard CLEAR, declined here. */
    | 'empty';

export interface Osc52Write {
    readonly kind: 'write';
    /** The selection as written (`''` for the omitted form; both mean the clipboard). */
    readonly selection: string;
    readonly text: string;
    /** DECODED byte count — what the log attributes, in place of the content. */
    readonly bytes: number;
}

export interface Osc52Read {
    readonly kind: 'read';
    readonly selection: string;
}

export interface Osc52Ignored {
    readonly kind: 'ignored';
    readonly reason: Osc52IgnoreReason;
    readonly selection: string;
    /** Length of `Pd` as it arrived, so an oversize drop can say how oversize. */
    readonly encodedLength: number;
}

export type Osc52Request = Osc52Write | Osc52Read | Osc52Ignored;

/** Standard base64 alphabet, with optional padding. No URL-safe forms, no whitespace. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function ignored(reason: Osc52IgnoreReason, selection: string, encodedLength: number): Osc52Ignored {
    return { kind: 'ignored', reason, selection, encodedLength };
}

/**
 * `data` is what xterm hands an OSC handler: everything after `52;`.
 *
 * Always returns a request — including an `ignored` one — because every branch here has a log
 * line attached to it. A parser that returned null for the uninteresting cases would make the
 * two most security-relevant events in the module (a refused read, a dropped oversize write)
 * indistinguishable from noise.
 */
export function parseOsc52(data: string): Osc52Request {
    const semi = data.indexOf(';');
    if (semi < 0) return ignored('malformed', '', data.length);
    const selection = data.slice(0, semi);
    const payload = data.slice(semi + 1);
    // ghostty's grammar: one byte, or none. `52;cs;…` is invalid there and is invalid here.
    if (selection.length > 1) return ignored('malformed', selection, payload.length);

    /*
     * The read test comes FIRST, before the selection is judged.
     *
     * `OSC 52 ; p ; ?` is still a program asking for the clipboard, and the log line that
     * matters is "a read was refused", not "an unusual selection was ignored". Refusing it
     * either way is the same silence; saying the right thing about it is not.
     */
    if (payload === '?') return { kind: 'read', selection };

    if (selection !== '' && selection !== 'c') return ignored('selection', selection, payload.length);
    if (payload === '') return ignored('empty', selection, 0);
    if (payload.length > OSC_52_MAX_ENCODED_LENGTH) return ignored('too-large', selection, payload.length);
    // `% 4 === 1` can never be a base64 group; the regex alone would let it through and Node's
    // lenient decoder would silently drop the stray character.
    if (!BASE64.test(payload) || payload.length % 4 === 1) {
        return ignored('not-base64', selection, payload.length);
    }

    const decoded = Buffer.from(payload, 'base64');
    // Non-empty base64 that decodes to nothing is not base64 (Node's decoder skips what it
    // cannot use rather than throwing, so this is the check that catches it).
    if (decoded.length === 0) return ignored('not-base64', selection, payload.length);
    if (decoded.length > OSC_52_MAX_DECODED_BYTES) return ignored('too-large', selection, payload.length);

    return {
        kind: 'write',
        selection,
        // UTF-8, lossily: OSC 52 carries selection TEXT, and a payload that is not valid UTF-8
        // is a program copying bytes the clipboard has no way to represent either.
        text: decoded.toString('utf8'),
        bytes: decoded.length
    };
}
