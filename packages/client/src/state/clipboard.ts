/**
 * §TERM-046's client end: a `clipboard-write` broadcast becomes a write to THIS machine's
 * clipboard.
 *
 * The daemon has already done everything a daemon can do — parsed the OSC 52 off the pane's VT
 * stream, refused it if it was a read, dropped it if `clipboard-write` is off — so what arrives
 * here is a text the user's own setting allowed. What is left is the part only a client can do,
 * and the reason this is a broadcast at all: **the PTY runs on the daemon's machine and the
 * clipboard belongs to the machine a client is displayed on** (terminal-surface.md §12's port
 * note). A browser attached from a laptop and an Electron window on the daemon's own host are
 * two different clipboards, and both are correct.
 *
 * ## Who actually writes it
 *
 * Two paths, and which one runs is decided by whether this page is inside a Kelpi shell window:
 *
 *   - **inside the Electron shell** (`?shellWindow=…`) the MAIN process writes it, off its own
 *     status socket (`shell/src/status.ts` → Electron's `clipboard.writeText`). That is the
 *     shell-bridge path this port uses for everything a page cannot do — the same route
 *     `reveal-path` and the notification posts take — and it works with no preload, no
 *     `contextBridge` and no user gesture. The page deliberately does NOT also write: two
 *     writers for one value is how they drift, and `navigator.clipboard` in a renderer is the
 *     half that can silently fail.
 *   - **a plain browser client** has no shell to do it, so it falls back to
 *     `navigator.clipboard.writeText`, best-effort. Browsers gate clipboard writes on transient
 *     activation and on the Permissions API, so a page the user has not interacted with may be
 *     refused. That is a real limitation, it is reported (`onResult`), and it is why the
 *     Electron path is the one the audit measures.
 *
 * ## Logging
 *
 * The write is attributable — pane id (short) and byte count — and **never the content**. The
 * daemon sends `bytes` precisely so that neither end has to measure (or hold, or log) the text
 * to say how big it was.
 */

/** The daemon's message type (protocol `WS_CLIPBOARD_WRITE_MESSAGE`). */
export const CLIPBOARD_WRITE_MESSAGE = 'clipboard-write';

export interface ClipboardWriteRequest {
    readonly paneID: string;
    readonly workspaceID: string;
    readonly text: string;
    /** The DECODED byte count the daemon measured. Never re-derived from `text`. */
    readonly bytes: number;
}

/**
 * Read a `clipboard-write` frame, or null when it is not one (or says nothing usable).
 *
 * `text` is the one field allowed to be empty-checked strictly: the daemon already declines a
 * zero-length write (a clipboard CLEAR), so an empty one here means a malformed frame, not a
 * request to wipe the user's clipboard.
 */
export function parseClipboardWrite(message: Record<string, unknown>): ClipboardWriteRequest | null {
    if (message['type'] !== CLIPBOARD_WRITE_MESSAGE) return null;
    const paneID = message['paneID'];
    const workspaceID = message['workspaceID'];
    const text = message['text'];
    if (typeof paneID !== 'string' || paneID === '') return null;
    if (typeof workspaceID !== 'string' || workspaceID === '') return null;
    if (typeof text !== 'string' || text === '') return null;
    const bytes = message['bytes'];
    return {
        paneID,
        workspaceID,
        text,
        bytes: typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? bytes : 0
    };
}

/** What happened, for the log line and for the tests. */
export type ClipboardWriteOutcome =
    /** This page is a shell window's; the main process owns the write. */
    | 'shell'
    /** Handed to `navigator.clipboard.writeText`. */
    | 'browser'
    /** A browser with no clipboard API at all (plain HTTP, an old engine). */
    | 'unavailable'
    /** The browser refused it (no transient activation, permission denied). */
    | 'refused';

export interface ClipboardWriteHandlerOptions {
    /** `?shellWindow=` — non-null means the Electron main process is writing it. */
    readonly shellWindowID: string | null;
    /** Defaults to `navigator.clipboard.writeText`; tests (and Node) pass their own. */
    readonly writeText?: ((text: string) => Promise<void>) | null | undefined;
    /** Attributable logging: pane + size, never the text. Defaults to `console.info`. */
    readonly log?: ((message: string) => void) | undefined;
    /** Test seam: told what happened, after the async write settles. */
    readonly onResult?: ((outcome: ClipboardWriteOutcome, request: ClipboardWriteRequest) => void) | undefined;
}

function defaultWriter(): ((text: string) => Promise<void>) | null {
    const clipboard = (globalThis.navigator as Navigator | undefined)?.clipboard;
    if (clipboard?.writeText === undefined) return null;
    return (text) => clipboard.writeText(text);
}

/**
 * The handler `connectStore` subscribes. Returns the outcome synchronously for the decision it
 * can make now; a browser write settles later and reports through `onResult`.
 */
export function createClipboardWriteHandler(
    options: ClipboardWriteHandlerOptions
): (message: Record<string, unknown>) => ClipboardWriteOutcome | null {
    const log = options.log ?? ((message: string) => console.info(message));

    return (message) => {
        const request = parseClipboardWrite(message);
        if (request === null) return null;
        const short = request.paneID.slice(0, 8);
        const size = `${String(request.bytes)} bytes`;

        if (options.shellWindowID !== null) {
            // The shell's own status socket carries the same broadcast, and Electron's
            // main-process clipboard is not subject to the page's activation rules.
            log(`clipboard: pane ${short} wrote ${size} (via the Kelpi shell)`);
            options.onResult?.('shell', request);
            return 'shell';
        }

        const writeText = options.writeText === undefined ? defaultWriter() : options.writeText;
        if (writeText === null) {
            log(`clipboard: pane ${short} wrote ${size} — but this browser exposes no clipboard`);
            options.onResult?.('unavailable', request);
            return 'unavailable';
        }

        void writeText(request.text).then(
            () => {
                log(`clipboard: pane ${short} wrote ${size}`);
                options.onResult?.('browser', request);
            },
            (error: unknown) => {
                // Best-effort by construction: a browser may require a user gesture the pane's
                // own output cannot supply. Reported, never retried, never surfaced as a toast —
                // a failed paste is a nuisance, a modal about one is worse.
                log(
                    `clipboard: pane ${short} wrote ${size} — the browser refused it (${String(error)})`
                );
                options.onResult?.('refused', request);
            }
        );
        return 'browser';
    };
}
