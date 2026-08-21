/**
 * §TERM-050's missing half — the OSC desktop-notification **source**.
 *
 * The delivery chain has been complete for three waves: `notificationDecision('osc', …)` has a
 * dedicated branch in `@nex/core/agent`, the daemon supplies real client focus/visibility, the
 * protocol already lists `'osc'` among `WS_NOTIFICATION_KINDS`, and the Electron shell posts a
 * native notification with the `nex-<paneID>` dedup identity. What nothing did was *raise* one:
 * no code in the repo parsed OSC 9 or OSC 777 out of a PTY stream, so the branch was dead.
 *
 * This is that parser. It sits where OSC 7 and OSC 0/2 already sit — on the headless VT every
 * PTY byte flows through (`term/service.ts`) — rather than in a second scanner over the raw
 * stream, so a sequence split across two `write()` chunks is reassembled by the emulator's own
 * parser instead of by a regex that would miss it.
 *
 * Two sequences, both of them what libghostty raises `GHOSTTY_ACTION_DESKTOP_NOTIFICATION` for
 * (`ghostty/src/terminal/osc.zig`):
 *
 *   - **OSC 9** — `ESC ] 9 ; <body> BEL`, iTerm2's original. Body only; the title is the
 *     caller's problem, and the Swift app's own fallback (`AppReducer+SearchNotify.swift:68-79`
 *     → `NotificationService.post`) is the pane's title, then the workspace name.
 *   - **OSC 777** — `ESC ] 777 ; notify ; <title> ; <body> BEL`, urxvt's. Anything after the
 *     third `;` belongs to the body, so a message containing a semicolon survives.
 *
 * Deliberately NOT handled, and each for a reason:
 *
 *   - `OSC 9 ; 4 ; …` (ConEmu's progress-bar extension) is still a notification here, exactly
 *     as it is in ghostty — ghostty parses OSC 9 as body-only and does not special-case 4, so
 *     a port that did would be diverging to be clever.
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
