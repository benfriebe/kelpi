import { describe, expect, it } from 'vitest';

import { FIRE_AND_FORGET_COMMANDS, isReplyCommand, isStreamingReply, REPLY_COMMANDS } from './allowlist.js';
import { WIRE_COMMANDS, type WireCommandName } from './wire/messages.js';

/** The fire-and-forget list, verbatim from wire-protocol.md §4. */
const SPEC_FIRE_AND_FORGET: readonly WireCommandName[] = [
    'start',
    'stop',
    'error',
    'notification',
    'session-start',
    'session-end',
    'pane-move',
    'pane-move-to-workspace',
    'workspace-move',
    'workspace-profile',
    'group-create',
    'group-rename',
    'group-delete',
    'layout-cycle',
    'layout-select',
    'open',
    'diff'
];

describe('reply allowlist table', () => {
    it('has the 54 documented request/response commands', () => {
        expect(REPLY_COMMANDS.size).toBe(54);
    });

    it('partitions every known command into reply / fire-and-forget', () => {
        for (const command of WIRE_COMMANDS) {
            expect(REPLY_COMMANDS.has(command) !== FIRE_AND_FORGET_COMMANDS.has(command)).toBe(true);
        }
        expect(REPLY_COMMANDS.size + FIRE_AND_FORGET_COMMANDS.size).toBe(WIRE_COMMANDS.length);
    });

    it('matches the spec fire-and-forget list exactly', () => {
        expect([...FIRE_AND_FORGET_COMMANDS].sort()).toEqual([...SPEC_FIRE_AND_FORGET].sort());
    });

    it('is by command name only — no request field opts in', () => {
        expect(isReplyCommand('pane-send')).toBe(true);
        expect(isReplyCommand('pane-move')).toBe(false);
        expect(isReplyCommand('pane-move-adjacent')).toBe(true);
        expect(isReplyCommand('')).toBe(false);
        expect(isReplyCommand('PANE-SEND')).toBe(false);
    });

    it('flags only web-console --follow as a streaming reply', () => {
        expect(isStreamingReply('web-console', true)).toBe(true);
        expect(isStreamingReply('web-console', false)).toBe(false);
        expect(isStreamingReply('pane-capture', true)).toBe(false);
    });

    it('covers every web-* command (all request/response)', () => {
        const webCommands = WIRE_COMMANDS.filter((command) => command.startsWith('web-'));
        expect(webCommands.length).toBe(31);
        for (const command of webCommands) expect(isReplyCommand(command)).toBe(true);
    });
});
