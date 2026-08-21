/**
 * OSC 9 / OSC 777 — the desktop-notification source (terminal-panes.md §TERM-050).
 *
 * Two halves, and the second is the one that was missing for four waves: the grammar, and the
 * fact that a sequence fed through a REAL `feed()` reaches a subscriber and does not print
 * itself onto the screen.
 *
 * Escape bytes are written `\u001b` on purpose. The neighbouring OSC 7 suite has them as
 * literal control characters, which are invisible in every editor and in every diff — the same
 * class of fixture bug the audit harness's `PUA` block documents.
 */

import { describe, expect, it } from 'vitest';

import {
    OSC_NOTIFY_MAX_LENGTH,
    parseOscNotification,
    type OscNotification
} from './osc-notify.js';
import { createTerminalStateService } from './service.js';

const PANE = 'eeeeeeee-0000-4000-8000-000000000001';
const ESC = '\u001b';

describe('parseOscNotification', () => {
    it('reads iTerm2 OSC 9 as a body with no title', () => {
        expect(parseOscNotification(9, 'build finished')).toEqual({
            title: null,
            body: 'build finished'
        });
    });

    it('reads urxvt OSC 777 as title + body', () => {
        expect(parseOscNotification(777, 'notify;Tests;42 passed')).toEqual({
            title: 'Tests',
            body: '42 passed'
        });
    });

    it('keeps semicolons inside the body of a 777', () => {
        expect(parseOscNotification(777, 'notify;Deploy;staging; then prod')).toEqual({
            title: 'Deploy',
            body: 'staging; then prod'
        });
    });

    it('treats a single-field 777 as the message, not as a title', () => {
        expect(parseOscNotification(777, 'notify;done')).toEqual({ title: null, body: 'done' });
    });

    it('drops a 777 whose verb is not `notify` (urxvt multiplexes other verbs here)', () => {
        expect(parseOscNotification(777, 'precmd;something')).toBeNull();
        expect(parseOscNotification(777, 'notifyX;a;b')).toBeNull();
    });

    it('drops an empty body — `ESC ] 9 ; BEL` clears a badge, it does not notify', () => {
        expect(parseOscNotification(9, '')).toBeNull();
        expect(parseOscNotification(9, '   ')).toBeNull();
        expect(parseOscNotification(777, 'notify;Title;')).toBeNull();
    });

    it('ignores any other OSC code', () => {
        expect(parseOscNotification(7, 'file:///tmp')).toBeNull();
        expect(parseOscNotification(2, 'a title')).toBeNull();
    });

    it('flattens embedded control bytes, so a notification stays one readable line', () => {
        expect(parseOscNotification(9, 'line one\u0007\u0001line two')).toEqual({
            title: null,
            body: 'line one line two'
        });
    });

    it('truncates a pathological payload rather than forwarding a megabyte', () => {
        const parsed = parseOscNotification(9, 'x'.repeat(OSC_NOTIFY_MAX_LENGTH * 4));
        expect(parsed?.body.length).toBe(OSC_NOTIFY_MAX_LENGTH);
    });
});

describe('the terminal state service raises OSC notifications for the right pane', () => {
    it('fires OSC 9 through a real feed', async () => {
        const seen: { paneID: string; notification: OscNotification }[] = [];
        const term = createTerminalStateService({
            onOscNotification: (paneID, notification) => {
                seen.push({ paneID, notification });
            }
        });
        term.attach(PANE, 80, 24);
        term.feed(PANE, `${ESC}]9;deploy done\u0007`);
        await term.flush(PANE);
        expect(seen).toEqual([{ paneID: PANE, notification: { title: null, body: 'deploy done' } }]);
        term.disposeAll();
    });

    it('fires OSC 777 with its title', async () => {
        const seen: OscNotification[] = [];
        const term = createTerminalStateService({
            onOscNotification: (_paneID, notification) => {
                seen.push(notification);
            }
        });
        term.attach(PANE, 80, 24);
        term.feed(PANE, `${ESC}]777;notify;Agent;needs your approval\u0007`);
        await term.flush(PANE);
        expect(seen).toEqual([{ title: 'Agent', body: 'needs your approval' }]);
        term.disposeAll();
    });

    /**
     * The reason the parse lives on the emulator rather than in a scanner over the raw stream:
     * a PTY hands over whatever the kernel had, and an OSC can straddle two reads.
     */
    it('reassembles a sequence split across two writes', async () => {
        const seen: OscNotification[] = [];
        const term = createTerminalStateService({
            onOscNotification: (_paneID, notification) => {
                seen.push(notification);
            }
        });
        term.attach(PANE, 80, 24);
        term.feed(PANE, `${ESC}]9;half`);
        term.feed(PANE, ` and half\u0007`);
        await term.flush(PANE);
        expect(seen).toEqual([{ title: null, body: 'half and half' }]);
        term.disposeAll();
    });

    it('leaves the screen alone — the sequence is consumed, never printed', async () => {
        const term = createTerminalStateService({ onOscNotification: () => {} });
        term.attach(PANE, 80, 24);
        term.feed(PANE, `before${ESC}]9;a notification\u0007after`);
        const text = await term.captureAsync(PANE, { scrollback: false });
        expect(text).toContain('before');
        expect(text).toContain('after');
        expect(text).not.toContain('a notification');
        term.disposeAll();
    });

    it('costs nothing when nobody subscribed', async () => {
        const term = createTerminalStateService();
        term.attach(PANE, 80, 24);
        term.feed(PANE, `${ESC}]9;ignored\u0007ready`);
        expect(await term.captureAsync(PANE, { scrollback: false })).toContain('ready');
        term.disposeAll();
    });

    it('does not fire for a malformed payload', async () => {
        const seen: OscNotification[] = [];
        const term = createTerminalStateService({
            onOscNotification: (_paneID, notification) => {
                seen.push(notification);
            }
        });
        term.attach(PANE, 80, 24);
        term.feed(PANE, `${ESC}]777;precmd;not a notification\u0007`);
        term.feed(PANE, `${ESC}]9;\u0007`);
        await term.flush(PANE);
        expect(seen).toEqual([]);
        term.disposeAll();
    });
});
