/**
 * Kitty keyboard protocol negotiation (§TERM-030).
 *
 * Two layers, deliberately: the pure fold (`applyKittySetMode`, `kittyQueryReply`) is asserted
 * on its own, and everything else is driven through a REAL `@xterm/headless` parse of the same
 * byte strings an application would emit — because the thing most likely to be wrong here is
 * not the arithmetic but whether xterm hands `CSI > 1 u` to the handler at all, and with which
 * parameter shape. Every sequence below is written as bytes for that reason.
 */

import headless from '@xterm/headless';
import { describe, expect, it } from 'vitest';

import {
    KITTY_DISAMBIGUATE,
    KITTY_REPORT_ALL_KEYS,
    KITTY_REPORT_EVENT_TYPES,
    KITTY_SET_MODE_CLEAR,
    KITTY_SET_MODE_OR,
    KITTY_SET_MODE_REPLACE,
    KITTY_STACK_MAX_DEPTH,
    SUPPORTED_KITTY_FLAGS,
    applyKittySetMode,
    kittyQueryReply,
    sanitizeFlags,
    trackKittyKeyboard
} from './kitty-keyboard.js';
import { createTerminalStateService, type TerminalStateServiceImpl } from './service.js';

// Same CJS-interop note as `service.ts`: a named ESM import of `@xterm/headless` throws.
const { Terminal } = headless;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function write(service: TerminalStateServiceImpl, paneID: string, data: string): Promise<void> {
    service.feed(paneID, encoder.encode(data));
    await service.flush(paneID);
}

function flagsOf(service: TerminalStateServiceImpl, paneID: string): number {
    return service.modes(paneID).kittyKeyboardFlags ?? 0;
}

/** A service whose `CSI ? u` replies land in an array, spelled out as text. */
function makeService(): { service: TerminalStateServiceImpl; replies: string[] } {
    const replies: string[] = [];
    const service = createTerminalStateService({
        onKittyReply: (_paneID, reply) => {
            replies.push(decoder.decode(reply));
        }
    });
    return { service, replies };
}

describe('SUPPORTED_KITTY_FLAGS', () => {
    it('advertises disambiguate + event types + all-keys, and nothing else', () => {
        // The progressive-enhancement contract: a bit that is not here must never appear in a
        // query reply, because the client's encoder cannot honour it exactly.
        expect(SUPPORTED_KITTY_FLAGS).toBe(0b1011);
        expect(SUPPORTED_KITTY_FLAGS & KITTY_DISAMBIGUATE).toBe(KITTY_DISAMBIGUATE);
        expect(SUPPORTED_KITTY_FLAGS & KITTY_REPORT_EVENT_TYPES).toBe(KITTY_REPORT_EVENT_TYPES);
        expect(SUPPORTED_KITTY_FLAGS & KITTY_REPORT_ALL_KEYS).toBe(KITTY_REPORT_ALL_KEYS);
        // report alternate keys (0b100) and report associated text (0b10000) are declined.
        expect(SUPPORTED_KITTY_FLAGS & 0b100).toBe(0);
        expect(SUPPORTED_KITTY_FLAGS & 0b10000).toBe(0);
    });

    it('sanitizes anything that is not a plain non-negative integer', () => {
        expect(sanitizeFlags(31)).toBe(11);
        expect(sanitizeFlags(-4)).toBe(0);
        expect(sanitizeFlags(Number.NaN)).toBe(0);
        expect(sanitizeFlags(Number.POSITIVE_INFINITY)).toBe(0);
        expect(sanitizeFlags(3.9)).toBe(3);
    });
});

describe('applyKittySetMode', () => {
    it('mode 1 (and an absent/unknown mode) replaces', () => {
        expect(applyKittySetMode(0b1011, 0b1, KITTY_SET_MODE_REPLACE)).toBe(0b1);
        expect(applyKittySetMode(0b1011, 0b1, 0)).toBe(0b1);
        expect(applyKittySetMode(0b1011, 0, KITTY_SET_MODE_REPLACE)).toBe(0);
    });

    it('mode 2 sets the named bits and keeps the rest', () => {
        expect(applyKittySetMode(0b1, 0b10, KITTY_SET_MODE_OR)).toBe(0b11);
        expect(applyKittySetMode(0b11, 0b10, KITTY_SET_MODE_OR)).toBe(0b11);
    });

    it('mode 3 clears the named bits and keeps the rest', () => {
        expect(applyKittySetMode(0b1011, 0b10, KITTY_SET_MODE_CLEAR)).toBe(0b1001);
        expect(applyKittySetMode(0b1011, 0b1011, KITTY_SET_MODE_CLEAR)).toBe(0);
    });

    it('never lets an unsupported bit into the state, by any mode', () => {
        expect(applyKittySetMode(0, 0b11111, KITTY_SET_MODE_REPLACE)).toBe(0b1011);
        expect(applyKittySetMode(0b1, 0b10100, KITTY_SET_MODE_OR)).toBe(0b1);
        expect(applyKittySetMode(0b1011, 0b10100, KITTY_SET_MODE_CLEAR)).toBe(0b1011);
    });
});

describe('kittyQueryReply', () => {
    it('is the CSI ? flags u form a real terminal answers with', () => {
        expect(decoder.decode(kittyQueryReply(0))).toBe('\x1b[?0u');
        expect(decoder.decode(kittyQueryReply(3))).toBe('\x1b[?3u');
        // The mask applies here too, so the reply can never over-promise.
        expect(decoder.decode(kittyQueryReply(31))).toBe('\x1b[?11u');
    });
});

describe('TerminalStateServiceImpl — kitty keyboard negotiation', () => {
    it('starts with the protocol off', () => {
        const { service } = makeService();
        service.attach('p', 20, 5);
        expect(flagsOf(service, 'p')).toBe(0);
    });

    it('CSI > flags u sets the flags, masked to what this terminal supports', async () => {
        const { service } = makeService();
        service.attach('p', 20, 5);
        await write(service, 'p', '\x1b[>1u');
        expect(flagsOf(service, 'p')).toBe(1);
        await write(service, 'p', '\x1b[>31u');
        // 0b11111 asked; 0b1011 is what this terminal will honour.
        expect(flagsOf(service, 'p')).toBe(11);
    });

    it('CSI > u with no parameter turns the protocol off (a push of zero flags)', async () => {
        const { service } = makeService();
        service.attach('p', 20, 5);
        await write(service, 'p', '\x1b[>3u');
        expect(flagsOf(service, 'p')).toBe(3);
        await write(service, 'p', '\x1b[>u');
        expect(flagsOf(service, 'p')).toBe(0);
    });

    it('pushes and pops restore the caller flags — the nested-application case', async () => {
        const { service } = makeService();
        service.attach('p', 20, 5);
        // A shell that wants disambiguation, then an editor inside it that wants everything.
        await write(service, 'p', '\x1b[>1u');
        await write(service, 'p', '\x1b[>11u');
        expect(flagsOf(service, 'p')).toBe(11);
        await write(service, 'p', '\x1b[<u');
        expect(flagsOf(service, 'p')).toBe(1);
        await write(service, 'p', '\x1b[<u');
        expect(flagsOf(service, 'p')).toBe(0);
    });

    it('CSI < n u pops n entries, and popping past the bottom lands on zero', async () => {
        const { service } = makeService();
        service.attach('p', 20, 5);
        await write(service, 'p', '\x1b[>1u\x1b[>3u\x1b[>11u');
        expect(flagsOf(service, 'p')).toBe(11);
        await write(service, 'p', '\x1b[<2u');
        expect(flagsOf(service, 'p')).toBe(1);
        // Two entries left on the stack (0 and the pre-push state); asking for ten still ends
        // with the protocol off rather than throwing or wrapping.
        await write(service, 'p', '\x1b[<10u');
        expect(flagsOf(service, 'p')).toBe(0);
    });

    it('CSI = flags ; mode u sets in place, without touching the stack', async () => {
        const { service } = makeService();
        service.attach('p', 20, 5);
        await write(service, 'p', '\x1b[>1u');
        await write(service, 'p', '\x1b[=2;2u'); // or-in event types
        expect(flagsOf(service, 'p')).toBe(3);
        await write(service, 'p', '\x1b[=1;3u'); // clear disambiguate
        expect(flagsOf(service, 'p')).toBe(2);
        await write(service, 'p', '\x1b[=8u'); // replace (mode defaults to 1)
        expect(flagsOf(service, 'p')).toBe(8);
        // The stack still holds exactly the one entry the push put there.
        await write(service, 'p', '\x1b[<u');
        expect(flagsOf(service, 'p')).toBe(0);
    });

    it('answers CSI ? u with CSI ? flags u, and answers it when nothing is set', async () => {
        const { service, replies } = makeService();
        service.attach('p', 20, 5);
        // Detection: a terminal without the protocol says nothing, so `?0u` is the "yes, and
        // nothing is on" answer applications look for.
        await write(service, 'p', '\x1b[?u');
        expect(replies).toEqual(['\x1b[?0u']);
        await write(service, 'p', '\x1b[>31u\x1b[?u');
        expect(replies.at(-1)).toBe('\x1b[?11u');
    });

    it('caps the stack depth, discarding the OLDEST entry rather than refusing the push', async () => {
        // Read straight off the tracker, because the DEPTH is the invariant and the service
        // exposes only the flags. Same parse path either way — a raw `Terminal` is what the
        // service builds — and the write callback is what makes "between pushes" a real moment.
        const term = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
        const tracker = trackKittyKeyboard(term);
        const feed = async (data: string): Promise<void> => {
            await new Promise<void>((resolve) => {
                term.write(data, resolve);
            });
        };
        try {
            for (let index = 0; index < KITTY_STACK_MAX_DEPTH + 8; index += 1) {
                await feed(`\x1b[>${index % 2 === 0 ? '1' : '3'}u`);
            }
            expect(tracker.stackDepth('normal')).toBe(KITTY_STACK_MAX_DEPTH);
            expect(tracker.flags).toBe(3);
            // The retained window still pops back in order: the most recent push is the first
            // thing restored, which is the property eviction must not break.
            await feed('\x1b[<u');
            expect(tracker.stackDepth('normal')).toBe(KITTY_STACK_MAX_DEPTH - 1);
            expect(tracker.flags).toBe(1);
        } finally {
            tracker.dispose();
            term.dispose();
        }
    });

    it('pops past the bottom of a capped stack without resurrecting an evicted value', async () => {
        const { service } = makeService();
        service.attach('p', 20, 5);
        for (let index = 0; index < KITTY_STACK_MAX_DEPTH + 8; index += 1) {
            await write(service, 'p', `\x1b[>${index % 2 === 0 ? '1' : '3'}u`);
        }
        // 40 pushes, 32 retained. Popping 40 times must end at zero — never at whichever value
        // happened to be under the discarded entries.
        for (let index = 0; index < KITTY_STACK_MAX_DEPTH + 8; index += 1) {
            await write(service, 'p', '\x1b[<u');
        }
        expect(flagsOf(service, 'p')).toBe(0);
    });

    it('RIS clears the flags and the whole stack', async () => {
        const { service } = makeService();
        service.attach('p', 20, 5);
        await write(service, 'p', '\x1b[>1u\x1b[>11u');
        expect(flagsOf(service, 'p')).toBe(11);
        await write(service, 'p', '\x1bc');
        expect(flagsOf(service, 'p')).toBe(0);
        // The stack went with it: a pop after a reset cannot resurrect the pre-reset flags.
        await write(service, 'p', '\x1b[<u');
        expect(flagsOf(service, 'p')).toBe(0);
    });

    it('gives the alternate screen its own flags and its own stack', async () => {
        const { service } = makeService();
        service.attach('p', 20, 5);
        await write(service, 'p', '\x1b[>1u');
        expect(flagsOf(service, 'p')).toBe(1);

        // A full-screen application enters the alternate screen and asks for everything.
        await write(service, 'p', '\x1b[?1049h');
        expect(flagsOf(service, 'p')).toBe(0);
        await write(service, 'p', '\x1b[>11u');
        expect(flagsOf(service, 'p')).toBe(11);

        // It then dies WITHOUT popping. The shell underneath must be exactly as it was.
        await write(service, 'p', '\x1b[?1049l');
        expect(flagsOf(service, 'p')).toBe(1);

        // And the alternate screen remembers its own state when it is entered again.
        await write(service, 'p', '\x1b[?1049h');
        expect(flagsOf(service, 'p')).toBe(11);
    });

    it('a query on the alternate screen reports the alternate screen s flags', async () => {
        const { service, replies } = makeService();
        service.attach('p', 20, 5);
        await write(service, 'p', '\x1b[>1u\x1b[?1049h\x1b[>3u\x1b[?u');
        expect(replies.at(-1)).toBe('\x1b[?3u');
        await write(service, 'p', '\x1b[?1049l\x1b[?u');
        expect(replies.at(-1)).toBe('\x1b[?1u');
    });

    it('a respawned pane starts over: dispose tears the stack down with the emulator', async () => {
        const { service } = makeService();
        service.attach('p', 20, 5);
        await write(service, 'p', '\x1b[>11u');
        expect(flagsOf(service, 'p')).toBe(11);
        service.dispose('p');
        service.attach('p', 20, 5);
        expect(flagsOf(service, 'p')).toBe(0);
    });

    it('publishes a transition through onModesChange, and only a real one', async () => {
        const seen: number[] = [];
        const service = createTerminalStateService({
            onModesChange: (_paneID, modes) => {
                seen.push(modes.kittyKeyboardFlags ?? 0);
            }
        });
        service.attach('p', 20, 5);
        await write(service, 'p', '\x1b[>3u');
        // A re-assert is still a PUSH — it stacks 3 on top of 3 — so the value does not move
        // and nothing is broadcast. Two pops are what it takes to get back to zero.
        await write(service, 'p', '\x1b[>3u');
        await write(service, 'p', '\x1b[<2u');
        expect(seen).toEqual([3, 0]);
    });

    it('leaves the protocol alone for sequences that only LOOK like it', async () => {
        const { service, replies } = makeService();
        service.attach('p', 20, 5);
        await write(service, 'p', '\x1b[>3u');
        // `CSI u` (SCORC, restore cursor) and `CSI > c` (secondary DA) share the letter and the
        // prefix respectively; neither may move the flags or produce a reply.
        await write(service, 'p', '\x1b[u\x1b[>c\x1b[?1002h');
        expect(flagsOf(service, 'p')).toBe(3);
        expect(replies).toEqual([]);
    });
});
