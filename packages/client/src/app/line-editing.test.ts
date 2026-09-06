/**
 * The three line-editing chords (#82).
 *
 * The bytes are pinned as bytes, against Ghostty's shipped darwin defaults
 * (`src/config/Config.zig:7315-7334`), because that is the entire contract: a `0x15` a shell's
 * line discipline recognises, not "something plausible".
 */

import { describe, expect, it } from 'vitest';

import {
    KILL_LINE_BACKWARD_BYTE,
    LINE_EDIT_BYTES,
    MOVE_TO_LINE_END_BYTE,
    MOVE_TO_LINE_START_BYTE,
    sendLineEdit
} from './line-editing';

function harness(options: { focused?: string | null; terminal?: boolean } = {}): {
    send: (action: Parameters<typeof sendLineEdit>[0]) => boolean;
    written: string[];
} {
    const written: string[] = [];
    return {
        written,
        send: (action) =>
            sendLineEdit(action, {
                focusedPaneID: () => ('focused' in options ? options.focused : 'pane-1') ?? null,
                writerFor: (paneID) =>
                    (options.terminal ?? true) ? (data) => written.push(`${paneID}:${data}`) : null
            })
    };
}

describe('LINE_EDIT_BYTES', () => {
    it('is Ghostty s macOS set, byte for byte', () => {
        // Config.zig:7332-7333 super+backspace -> text "\x15" (ctrl+u, unix-line-discard)
        expect(KILL_LINE_BACKWARD_BYTE).toBe('\x15');
        // :7327-7328 super+arrow_left -> "\x01" (ctrl+a, beginning-of-line)
        expect(MOVE_TO_LINE_START_BYTE).toBe('\x01');
        // :7322-7323 super+arrow_right -> "\x05" (ctrl+e, end-of-line)
        expect(MOVE_TO_LINE_END_BYTE).toBe('\x05');
        expect(LINE_EDIT_BYTES).toEqual({
            kill_line_backward: '\x15',
            move_to_line_start: '\x01',
            move_to_line_end: '\x05'
        });
    });

    it('carries exactly three actions, so the set cannot drift from the citation', () => {
        expect(Object.keys(LINE_EDIT_BYTES).sort()).toEqual([
            'kill_line_backward',
            'move_to_line_end',
            'move_to_line_start'
        ]);
    });
});

describe('sendLineEdit', () => {
    it('writes the byte to the focused terminal pane and consumes the chord', () => {
        const h = harness();
        expect(h.send('kill_line_backward')).toBe(true);
        expect(h.send('move_to_line_start')).toBe(true);
        expect(h.send('move_to_line_end')).toBe(true);
        expect(h.written).toEqual(['pane-1:\x15', 'pane-1:\x01', 'pane-1:\x05']);
    });

    it('declines for a pane with no terminal renderer, so ⌘← still moves a text caret', () => {
        const h = harness({ terminal: false });
        expect(h.send('kill_line_backward')).toBe(false);
        expect(h.written).toEqual([]);
    });

    it('declines when nothing is focused', () => {
        const h = harness({ focused: null });
        expect(h.send('move_to_line_end')).toBe(false);
        expect(h.written).toEqual([]);
    });

    it('declines an action outside the table rather than claiming the key and writing nothing', () => {
        const h = harness();
        expect(h.send('split_right')).toBe(false);
        expect(h.written).toEqual([]);
    });
});
