/**
 * OSC 52 — the clipboard sequence (terminal-panes.md §TERM-046).
 *
 * Two halves, like `osc-notify.test.ts`: the grammar, and the fact that a sequence fed through a
 * REAL `feed()` reaches a subscriber, does not print itself onto the screen, and — the half this
 * item exists for — never produces a single byte back toward the PTY.
 *
 * Escape bytes are written `\u001b` on purpose: an invisible control character in a fixture is
 * the class of bug the neighbouring suite's header documents.
 */

import headless from '@xterm/headless';
import { describe, expect, it } from 'vitest';

import {
    OSC_52_MAX_DECODED_BYTES,
    OSC_52_MAX_ENCODED_LENGTH,
    parseOsc52,
    type Osc52Request
} from './osc52.js';
import { createTerminalStateService } from './service.js';

const { Terminal } = headless;

const PANE = 'cccccccc-0000-4000-8000-000000000001';
const ESC = '\u001b';
const BEL = '\u0007';
/** String Terminator — the ST-terminated form, `ESC \`. */
const ST = `${ESC}\\`;

function b64(text: string): string {
    return Buffer.from(text, 'utf8').toString('base64');
}

describe('parseOsc52 — the grammar', () => {
    it('reads `c` as the clipboard and decodes the payload', () => {
        expect(parseOsc52(`c;${b64('hello clipboard')}`)).toEqual({
            kind: 'write',
            selection: 'c',
            text: 'hello clipboard',
            bytes: 15
        });
    });

    /** ghostty's own `"OSC 52: get/set clipboard (optional parameter)"` test, transcribed. */
    it('treats an OMITTED selection as the clipboard, exactly as ghostty does', () => {
        expect(parseOsc52(`;${b64('implicit')}`)).toMatchObject({
            kind: 'write',
            selection: '',
            text: 'implicit'
        });
    });

    it('decodes UTF-8 rather than assuming ASCII', () => {
        const text = `${String.fromCodePoint(0x6f22)}字 — ok`;
        const parsed = parseOsc52(`c;${b64(text)}`) as Extract<Osc52Request, { kind: 'write' }>;
        expect(parsed.text).toBe(text);
        // The byte count is BYTES, not characters — it is what the log attributes.
        expect(parsed.bytes).toBe(Buffer.byteLength(text, 'utf8'));
        expect(parsed.bytes).toBeGreaterThan(text.length);
    });

    it('accepts the unpadded form some senders emit', () => {
        // `abc` → `YWJj` (no padding needed); `ab` → `YWI=` padded, `YWI` unpadded.
        expect(parseOsc52('c;YWI')).toMatchObject({ kind: 'write', text: 'ab' });
        expect(parseOsc52('c;YWI=')).toMatchObject({ kind: 'write', text: 'ab' });
    });

    it('ignores selections this port does not honour, naming the one it saw', () => {
        for (const selection of ['p', 's', 'q', '0', '7']) {
            expect(parseOsc52(`${selection};${b64('nope')}`)).toEqual({
                kind: 'ignored',
                reason: 'selection',
                selection,
                encodedLength: b64('nope').length
            });
        }
    });

    /** ghostty's grammar is ONE byte or none; `cs` (xterm's multi-selection form) is invalid. */
    it('rejects a multi-byte selection field as malformed', () => {
        expect(parseOsc52(`cs;${b64('x')}`)).toMatchObject({ kind: 'ignored', reason: 'malformed' });
    });

    it('is malformed when there is no `;` at all', () => {
        expect(parseOsc52('c')).toEqual({ kind: 'ignored', reason: 'malformed', selection: '', encodedLength: 1 });
        expect(parseOsc52('')).toMatchObject({ kind: 'ignored', reason: 'malformed' });
    });

    it('reads `?` as a READ request, for any selection', () => {
        expect(parseOsc52('c;?')).toEqual({ kind: 'read', selection: 'c' });
        expect(parseOsc52(';?')).toEqual({ kind: 'read', selection: '' });
        // A read on a selection this port would not WRITE is still a read, and the log has to
        // say so rather than filing it as "unusual selection".
        expect(parseOsc52('p;?')).toEqual({ kind: 'read', selection: 'p' });
    });

    it('is not fooled by a payload that merely contains `?`', () => {
        expect(parseOsc52(`c;${b64('?')}`)).toMatchObject({ kind: 'write', text: '?' });
        expect(parseOsc52('c;??')).toMatchObject({ kind: 'ignored', reason: 'not-base64' });
    });

    it('drops base64 garbage rather than pasting mangled bytes', () => {
        expect(parseOsc52('c;not base64!!')).toMatchObject({ kind: 'ignored', reason: 'not-base64' });
        expect(parseOsc52('c;****')).toMatchObject({ kind: 'ignored', reason: 'not-base64' });
        // `% 4 === 1` can never be a base64 group; Node's lenient decoder would drop the stray
        // character and hand back "abc" as if nothing were wrong.
        expect(parseOsc52('c;YWJjZ')).toMatchObject({ kind: 'ignored', reason: 'not-base64' });
        // Alphabet-clean but decodes to nothing.
        expect(parseOsc52('c;=')).toMatchObject({ kind: 'ignored', reason: 'not-base64' });
    });

    it('declines a clipboard CLEAR (an empty payload), unlike ghostty', () => {
        expect(parseOsc52('c;')).toEqual({ kind: 'ignored', reason: 'empty', selection: 'c', encodedLength: 0 });
    });

    it('drops an oversize payload instead of truncating it', () => {
        const huge = b64('x'.repeat(OSC_52_MAX_DECODED_BYTES + 1));
        expect(parseOsc52(`c;${huge}`)).toMatchObject({ kind: 'ignored', reason: 'too-large' });
        // …and refuses to even decode one that could not possibly fit.
        const absurd = 'A'.repeat(OSC_52_MAX_ENCODED_LENGTH + 4);
        expect(parseOsc52(`c;${absurd}`)).toMatchObject({ kind: 'ignored', reason: 'too-large' });
    });

    it('accepts a payload exactly at the cap', () => {
        const atCap = b64('y'.repeat(OSC_52_MAX_DECODED_BYTES));
        expect(parseOsc52(`c;${atCap}`)).toMatchObject({ kind: 'write', bytes: OSC_52_MAX_DECODED_BYTES });
    });
});

describe('the terminal state service raises OSC 52 for the right pane', () => {
    function serviceWith(seen: { paneID: string; request: Osc52Request }[]) {
        return createTerminalStateService({
            onClipboardRequest: (paneID, request) => {
                seen.push({ paneID, request });
            }
        });
    }

    it('fires a BEL-terminated write through a real feed', async () => {
        const seen: { paneID: string; request: Osc52Request }[] = [];
        const term = serviceWith(seen);
        term.attach(PANE, 80, 24);
        term.feed(PANE, `${ESC}]52;c;${b64('from the pty')}${BEL}`);
        await term.flush(PANE);
        expect(seen).toEqual([
            { paneID: PANE, request: { kind: 'write', selection: 'c', text: 'from the pty', bytes: 12 } }
        ]);
        term.disposeAll();
    });

    it('fires an ST-terminated write too (the form `printf` scripts often use)', async () => {
        const seen: { paneID: string; request: Osc52Request }[] = [];
        const term = serviceWith(seen);
        term.attach(PANE, 80, 24);
        term.feed(PANE, `${ESC}]52;c;${b64('terminated by ST')}${ST}`);
        await term.flush(PANE);
        expect(seen[0]?.request).toMatchObject({ kind: 'write', text: 'terminated by ST' });
        term.disposeAll();
    });

    /**
     * The reason the parse lives on the emulator rather than in a scanner over the raw stream: a
     * PTY hands over whatever the kernel had, and a base64 payload is exactly the kind of long
     * run that straddles a read boundary.
     */
    it('reassembles a sequence split across three writes', async () => {
        const seen: { paneID: string; request: Osc52Request }[] = [];
        const term = serviceWith(seen);
        const payload = b64('a payload that arrived in pieces');
        term.attach(PANE, 80, 24);
        term.feed(PANE, `${ESC}]52;c;${payload.slice(0, 5)}`);
        term.feed(PANE, payload.slice(5, 12));
        term.feed(PANE, `${payload.slice(12)}${BEL}`);
        await term.flush(PANE);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.request).toMatchObject({ kind: 'write', text: 'a payload that arrived in pieces' });
        term.disposeAll();
    });

    it('leaves the screen alone — the sequence is consumed, never printed', async () => {
        const term = createTerminalStateService({ onClipboardRequest: () => {} });
        term.attach(PANE, 80, 24);
        term.feed(PANE, `before${ESC}]52;c;${b64('secret')}${BEL}after`);
        const text = await term.captureAsync(PANE, { scrollback: false });
        expect(text).toContain('before');
        expect(text).toContain('after');
        expect(text).not.toContain(b64('secret'));
        term.disposeAll();
    });

    it('reports an ignored sequence rather than swallowing it (every branch has a log line)', async () => {
        const seen: { paneID: string; request: Osc52Request }[] = [];
        const term = serviceWith(seen);
        term.attach(PANE, 80, 24);
        term.feed(PANE, `${ESC}]52;p;${b64('primary')}${BEL}`);
        term.feed(PANE, `${ESC}]52;c;!!!!${BEL}`);
        await term.flush(PANE);
        expect(seen.map((entry) => entry.request)).toMatchObject([
            { kind: 'ignored', reason: 'selection' },
            { kind: 'ignored', reason: 'not-base64' }
        ]);
        term.disposeAll();
    });

    it('costs nothing when nobody subscribed, and still consumes the sequence', async () => {
        const term = createTerminalStateService();
        term.attach(PANE, 80, 24);
        term.feed(PANE, `${ESC}]52;c;${b64('ignored')}${BEL}ready`);
        expect(await term.captureAsync(PANE, { scrollback: false })).toContain('ready');
        term.disposeAll();
    });
});

/**
 * The refusal, asserted three ways.
 *
 * A terminal that answers `OSC 52 ; c ; ?` hands the developer's clipboard to whatever is running
 * in the pane. "We do not answer" therefore has to be proven, not asserted: the sink is told it
 * was a read, the service's ONE path to the PTY is never taken, and the emulator underneath has
 * no responder of its own that could answer behind the service's back.
 */
describe('an OSC 52 READ is refused and nothing goes back to the PTY', () => {
    it('reports the read and never invokes the PTY-write callback', async () => {
        const seen: Osc52Request[] = [];
        /** `onKittyReply` is the only callback in this service that writes to a PTY. */
        const toPty: Uint8Array[] = [];
        const term = createTerminalStateService({
            onClipboardRequest: (_paneID, request) => {
                seen.push(request);
            },
            onKittyReply: (_paneID, reply) => {
                toPty.push(reply);
            }
        });
        term.attach(PANE, 80, 24);
        term.feed(PANE, `${ESC}]52;c;?${BEL}`);
        term.feed(PANE, `${ESC}]52;;?${BEL}`);
        await term.flush(PANE);
        expect(seen).toEqual([
            { kind: 'read', selection: 'c' },
            { kind: 'read', selection: '' }
        ]);
        expect(toPty).toEqual([]);
        term.disposeAll();
    });

    /**
     * The control: a kitty-keyboard query DOES produce bytes for the PTY through that same
     * callback, so "no bytes" above is a fact about OSC 52 rather than about a dead callback.
     */
    it('…while a sequence that legitimately owes the PTY an answer still gets one', async () => {
        const toPty: Uint8Array[] = [];
        const term = createTerminalStateService({
            onKittyReply: (_paneID, reply) => {
                toPty.push(reply);
            }
        });
        term.attach(PANE, 80, 24);
        term.feed(PANE, `${ESC}[?u`);
        await term.flush(PANE);
        expect(toPty).toHaveLength(1);
        term.disposeAll();
    });

    /**
     * And underneath: `@xterm/headless` itself has no OSC 52 responder (clipboard access is an
     * addon there, and this service loads no such addon), so nothing can answer behind the
     * service's back. Asserted against a bare Terminal because `onData` is where a device reply
     * would appear — and the service deliberately never subscribes to it.
     */
    it('the emulator itself emits nothing for OSC 52', async () => {
        const emitted: string[] = [];
        const bare = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
        bare.onData((data) => emitted.push(data));
        bare.onBinary((data) => emitted.push(data));
        await new Promise<void>((resolve) => {
            bare.write(`${ESC}]52;c;?${BEL}`, resolve);
        });
        expect(emitted).toEqual([]);
        // The control again, one level down: a DA1 query DOES make xterm talk.
        await new Promise<void>((resolve) => {
            bare.write(`${ESC}[c`, resolve);
        });
        expect(emitted.length).toBeGreaterThan(0);
        bare.dispose();
    });
});
