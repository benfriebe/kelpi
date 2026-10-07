/**
 * §TERM-050's missing half — the OSC desktop-notification **source**.
 *
 * The delivery chain has been complete for three waves: `notificationDecision('osc', …)` has a
 * dedicated branch in `@kelpi/core/agent`, the daemon supplies real client focus/visibility, the
 * protocol already lists `'osc'` among `WS_NOTIFICATION_KINDS`, and the Electron shell posts a
 * native notification with the `kelpi-<paneID>` dedup identity. What nothing did was *raise* one:
 * no code in the repo parsed OSC 9 or OSC 777 out of a PTY stream, so the branch was dead.
 *
 * This is that parser. It sits where OSC 7 and OSC 0/2 already sit — on the headless VT every
 * PTY byte flows through (`term/service.ts`) — rather than in a second scanner over the raw
 * stream, so a sequence split across two `write()` chunks is reassembled by the emulator's own
 * parser instead of by a regex that would miss it.
 *
 * Two sequences, both of them what libghostty raises `GHOSTTY_ACTION_DESKTOP_NOTIFICATION` for
 * (`ghostty/src/terminal/osc/parsers/osc9.zig` and `rxvt_extension.zig`):
 *
 *   - **OSC 9** — `ESC ] 9 ; <body> BEL`, iTerm2's original. Body only; the title is the
 *     caller's problem, and the Swift app's own fallback (`AppReducer+SearchNotify.swift:68-79`
 *     → `NotificationService.post`) is the pane's title, then the workspace name.
 *   - **OSC 777** — `ESC ] 777 ; notify ; <title> ; <body> BEL`, urxvt's. Anything after the
 *     third `;` belongs to the body, so a message containing a semicolon survives.
 *
 * Deliberately NOT handled, and each for a reason:
 *
 *   - ConEmu's own commands, which share OSC 9 with iTerm2's message (sleep, message box, tab
 *     title, the `9;4` progress bar, the `9;9` working directory and the rest), are dropped
 *     wherever ghostty parses them as ConEmu (`CONEMU_COMMAND` below): posting one would put
 *     "4;1;50" in a desktop notification.
 *   - a `777` payload whose first field is not `notify` is dropped: urxvt multiplexes other
 *     verbs through the same code and none of them is a notification.
 *   - an empty body is dropped. `ESC ] 9 ; BEL` is how a script clears iTerm2's badge, and a
 *     notification with no text is a notification nobody can read.
 */

/** One parsed OSC notification. `title === null` means "use the pane's own name". */
export interface OscNotification {
    readonly title: string | null;
    readonly body: string;
}

/** The OSC identifiers this module claims. */
export const OSC_NOTIFY_CODE = 9;
export const OSC_NOTIFY_URXVT_CODE = 777;

/**
 * Longest notification text accepted, in characters, per field.
 *
 * A PTY is an untrusted byte source: `cat` of a binary file can emit a well-formed OSC with a
 * megabyte of payload, and every byte of it would cross the socket and land in a native
 * notification. Ghostty caps its OSC buffer for the same reason. Over-long text is truncated
 * rather than dropped, so a legitimate long message still notifies.
 */
export const OSC_NOTIFY_MAX_LENGTH = 512;

/**
 * ConEmu's OSC 9 commands, told apart from an iTerm2 message the way ghostty's
 * `osc/parsers/osc9.zig` (ghostty 500040d) does it: one alternative per verb.
 *
 * A payload that starts like a verb but breaks its grammar (`4`, `4;`, `4;5`, `9`, `10;`) is
 * not matched and still notifies, as it does in ghostty. `9;5` and `9;12` take no argument
 * and ghostty checks nothing after them, so a message starting `5` or `12` is swallowed there
 * and here alike.
 */
const CONEMU_COMMAND = new RegExp(
    `^(?:${[
        '1;', // 9;1 sleep
        '10(?:$|;[0-3])', // 9;10 xterm keyboard and output emulation
        '11;', // 9;11 comment
        '12', // 9;12 mark prompt start
        '2;', // 9;2 message box
        '3;', // 9;3 tab title (an empty one resets it)
        '4;[0-4]', // 9;4 progress report
        '5', // 9;5 wait for input
        '[6-9];' // 9;6 GUI macro, 9;7 run process, 9;8 print an env var, 9;9 working directory
    ].join('|')})`
);

/** Strip C0/DEL controls (a notification is one line of text) and clamp the length. */
function sanitize(value: string): string {
    // Escapes, never literal control bytes: an invisible character in this source would be
    // impossible to review and trivial to lose to a reformat.
    const flattened = value.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
    return flattened.length > OSC_NOTIFY_MAX_LENGTH ? flattened.slice(0, OSC_NOTIFY_MAX_LENGTH) : flattened;
}

/**
 * `data` is what xterm hands an OSC handler: everything after `<code>;`.
 * Returns null for anything that is not a notification, which the handler reports as
 * "not handled" so the sequence stays available to any other consumer.
 */
export function parseOscNotification(code: number, data: string): OscNotification | null {
    if (code === OSC_NOTIFY_CODE) {
        if (CONEMU_COMMAND.test(data)) return null;
        const body = sanitize(data);
        return body === '' ? null : { title: null, body };
    }
    if (code !== OSC_NOTIFY_URXVT_CODE) return null;
    const parts = data.split(';');
    if (parts[0] !== 'notify') return null;
    if (parts.length === 2) {
        // `777;notify;text` — one field, and it reads as the message, not as a title.
        const body = sanitize(parts[1] ?? '');
        return body === '' ? null : { title: null, body };
    }
    if (parts.length < 3) return null;
    const title = sanitize(parts[1] ?? '');
    const body = sanitize(parts.slice(2).join(';'));
    if (body === '') return null;
    return { title: title === '' ? null : title, body };
}
