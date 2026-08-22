/**
 * §TERM-046's shell half — decoding the daemon's `clipboard-write` broadcast.
 *
 * The write itself is one `clipboard.writeText` call in `main.ts` that no plain-Node test can
 * reach (an `electron` import does not resolve here), so what is testable is what has to be
 * right for that call to be safe: which frames reach it, which never do, and what the log says
 * about the ones that do.
 */

import { describe, expect, it } from 'vitest';

import { CLIPBOARD_WRITE_MESSAGE, clipboardWriteLogLine, parseClipboardWrite } from './clipboard.js';

const PANE = 'dddddddd-0000-4000-8000-000000000001';
const WORKSPACE = 'aaaaaaaa-0000-4000-8000-000000000001';

function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: CLIPBOARD_WRITE_MESSAGE,
        paneID: PANE,
        workspaceID: WORKSPACE,
        text: 'from a pane',
        bytes: 11,
        ...overrides
    };
}

describe('the shell clipboard bridge', () => {
    it('reads a well-formed frame', () => {
        expect(parseClipboardWrite(frame())).toEqual({
            paneID: PANE,
            workspaceID: WORKSPACE,
            text: 'from a pane',
            bytes: 11
        });
    });

    it('ignores every other message on the status socket', () => {
        expect(parseClipboardWrite({ type: 'notification', paneID: PANE })).toBeNull();
        expect(parseClipboardWrite({ type: 'reveal-path', path: '/tmp' })).toBeNull();
        expect(parseClipboardWrite(null)).toBeNull();
        expect(parseClipboardWrite('clipboard-write')).toBeNull();
    });

    /**
     * The daemon declines a zero-length OSC 52 (ghostty's clipboard CLEAR), so an empty text
     * here means a malformed frame — and wiping the user's clipboard on a malformed frame is
     * the one outcome worse than doing nothing.
     */
    it('never writes an empty string', () => {
        expect(parseClipboardWrite(frame({ text: '' }))).toBeNull();
        expect(parseClipboardWrite(frame({ text: null }))).toBeNull();
    });

    it('refuses a frame with nothing to attribute the write to', () => {
        expect(parseClipboardWrite(frame({ paneID: '' }))).toBeNull();
        expect(parseClipboardWrite(frame({ workspaceID: 7 }))).toBeNull();
    });

    it('defaults a missing byte count rather than measuring the text', () => {
        expect(parseClipboardWrite(frame({ bytes: undefined }))?.bytes).toBe(0);
        expect(parseClipboardWrite(frame({ bytes: Number.NaN }))?.bytes).toBe(0);
    });

    /**
     * The log line is the only trace a clipboard write leaves — the clipboard itself is OS state
     * no screenshot reaches — so it has to name the pane and the size, and must not name the
     * text. A shell log that transcribed every copy would be a password file.
     */
    it('logs the pane and the size, and never the content', () => {
        const write = parseClipboardWrite(frame({ text: 'hunter2', bytes: 7 }));
        expect(write).not.toBeNull();
        const line = clipboardWriteLogLine(write as NonNullable<typeof write>);
        expect(line).toBe(`clipboard: wrote 7 bytes from pane ${PANE.slice(0, 8)}`);
        expect(line).not.toContain('hunter2');
    });
});
