/**
 * §TERM-046's shell half: decoding a daemon `clipboard-write` broadcast.
 *
 * The main process is the *authoritative* writer for an Electron window. `status.ts` is already
 * attached to the daemon as a near-read-only client, the same socket that carries notifications
 * and `reveal-path`, so an OSC 52 the daemon allowed arrives here without a preload, without
 * `ipcRenderer`, and without the renderer's transient-activation rules — which is exactly why
 * the page defers to this path when it is running inside a shell window
 * (`client/src/state/clipboard.ts`).
 *
 * Pure, like `./notify.ts` and `./shell-actions.ts`, because anything that imports `electron`
 * cannot be unit-tested under plain Node (`vitest.config.mts`). The decode and the log line are
 * here; the one call to `clipboard.writeText` is in `status.ts`.
 *
 * **The log line never carries the text.** The daemon sends `bytes` for exactly this reason: a
 * write is attributable — which pane, how much — without the shell log becoming a transcript of
 * everything the user has copied. A clipboard payload is a password as often as it is a URL.
 */

/** The daemon's message type (protocol `WS_CLIPBOARD_WRITE_MESSAGE`). */
export const CLIPBOARD_WRITE_MESSAGE = 'clipboard-write';

export interface ShellClipboardWrite {
    readonly paneID: string;
    readonly workspaceID: string;
    readonly text: string;
    /** The DECODED byte count the daemon measured. Never re-derived from `text`. */
    readonly bytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/**
 * Read a `clipboard-write` frame, or null when it is not one (or says nothing usable).
 *
 * An empty `text` is refused rather than written: the daemon already declines a zero-length OSC
 * 52 (ghostty's clipboard CLEAR), so an empty one arriving here means a malformed frame, and
 * wiping the user's clipboard on a malformed frame would be the worst possible reading of it.
 */
export function parseClipboardWrite(message: unknown): ShellClipboardWrite | null {
    if (!isRecord(message)) return null;
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

/**
 * The one-line shape `status.ts` logs when it writes, so the audit and the smoke can assert that
 * a REAL clipboard write happened and *which pane* caused it — the clipboard itself is OS state
 * no screenshot reaches. Pane id is shortened the way every other shell log line shortens ids.
 */
export function clipboardWriteLogLine(write: ShellClipboardWrite): string {
    return `clipboard: wrote ${String(write.bytes)} bytes from pane ${write.paneID.slice(0, 8)}`;
}
