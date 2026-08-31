import { describe, expect, it } from 'vitest';

import { dispatchSequence, synthesizeSessionStart } from './dualfire.js';
import { parseWireLine, type WireDecodeSuccess } from './wire/decode.js';

const PANE = '1b4e4e5a-9f2b-4c58-8d1f-2a81d9a3e111';
const PANE_UPPER = '1B4E4E5A-9F2B-4C58-8D1F-2A81D9A3E111';

function decoded(payload: Record<string, unknown>): WireDecodeSuccess {
    const result = parseWireLine(JSON.stringify(payload));
    if (!result.ok) throw new Error(`expected success: ${result.detail}`);
    return result;
}

describe('session_id dual-fire', () => {
    it('synthesizes a session-start after a stop that carries a session id', () => {
        const event = synthesizeSessionStart(decoded({ command: 'stop', pane_id: PANE, session_id: 'abc-123' }));
        expect(event).toEqual({
            kind: 'session-start-dualfire',
            source_command: 'stop',
            pane_id: PANE_UPPER,
            session_id: 'abc-123',
            agent: 'claude'
        });
    });

    it('carries the launch profile riding the line, and omits an absent or empty one', () => {
        const event = synthesizeSessionStart(
            decoded({ command: 'stop', pane_id: PANE, session_id: 'abc-123', profile: 'work' })
        );
        expect(event?.profile).toBe('work');
        expect(
            synthesizeSessionStart(decoded({ command: 'stop', pane_id: PANE, session_id: 'abc-123' }))
        ).not.toHaveProperty('profile');
        expect(
            synthesizeSessionStart(decoded({ command: 'stop', pane_id: PANE, session_id: 'abc-123', profile: '' }))
        ).not.toHaveProperty('profile');
    });

    it('carries the line agent field, case-insensitively', () => {
        const event = synthesizeSessionStart(
            decoded({ command: 'notification', pane_id: PANE, session_id: 's1', agent: 'Codex' })
        );
        expect(event?.agent).toBe('codex');
        const unknownAgent = synthesizeSessionStart(
            decoded({ command: 'stop', pane_id: PANE, session_id: 's1', agent: 'gemini' })
        );
        expect(unknownAgent?.agent).toBe('claude');
    });

    it('fires for any command family, tagged with the original wire command', () => {
        for (const payload of [
            { command: 'start', pane_id: PANE, session_id: 's1' },
            { command: 'error', pane_id: PANE, session_id: 's1', message: 'boom' },
            { command: 'notification', pane_id: PANE, session_id: 's1' },
            { command: 'pane-send', pane_id: PANE, target: 'worker', text: 'ls', session_id: 's1' }
        ]) {
            const event = synthesizeSessionStart(decoded(payload));
            expect(event?.source_command).toBe(payload.command);
            expect(event?.session_id).toBe('s1');
        }
    });

    it('never fires for session-start / session-end', () => {
        expect(
            synthesizeSessionStart(decoded({ command: 'session-start', pane_id: PANE, session_id: 's1' }))
        ).toBeUndefined();
        expect(
            synthesizeSessionStart(decoded({ command: 'session-end', pane_id: PANE, session_id: 's1' }))
        ).toBeUndefined();
    });

    it('needs a valid pane id and a non-empty session id', () => {
        expect(synthesizeSessionStart(decoded({ command: 'stop', pane_id: PANE, session_id: '' }))).toBeUndefined();
        expect(synthesizeSessionStart(decoded({ command: 'stop', pane_id: PANE }))).toBeUndefined();
        expect(
            synthesizeSessionStart(decoded({ command: 'pane-list', pane_id: 'not-a-uuid', session_id: 's1' }))
        ).toBeUndefined();
    });
});

describe('dispatch sequence', () => {
    it('orders the synthesized event after the primary message', () => {
        const items = dispatchSequence(decoded({ command: 'stop', pane_id: PANE, session_id: 's1' }));
        expect(items).toHaveLength(2);
        expect(items[0]).toMatchObject({ kind: 'message', message: { command: 'stop' }, reply: false });
        expect(items[1]).toMatchObject({ kind: 'session-start-dualfire', reply: false });
    });

    it('never allocates a reply for the dual-fire, even on an allowlisted primary', () => {
        const items = dispatchSequence(
            decoded({ command: 'pane-send', pane_id: PANE, target: 'worker', text: 'ls', session_id: 's1' })
        );
        expect(items).toHaveLength(2);
        expect(items[0]).toMatchObject({ kind: 'message', reply: true });
        expect(items[1]?.reply).toBe(false);
    });

    it('is a single item when the dual-fire rule does not apply', () => {
        const items = dispatchSequence(decoded({ command: 'ping' }));
        expect(items).toEqual([{ kind: 'message', message: { command: 'ping' }, reply: true }]);
    });
});
