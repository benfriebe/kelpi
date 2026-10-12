import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every payload sent to the daemon. */
const sent = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('../transport.js', async (original) => ({
    ...(await original<object>()),
    sendJSON: (payload: Record<string, unknown>) => {
        sent.push(payload);
        return Promise.resolve();
    }
}));

import { setEnv } from '../env.js';
import { ASSISTANT_MESSAGE_MAX_BYTES, capAssistantMessage, handleEvent } from './event.js';

const PANE = '1B4E4E5A-9F2B-4C58-8D1F-2A81D9A3E111';
const SESSION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const TRANSCRIPT = '/home/user/.claude/projects/-work-app/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.jsonl';

/** Pipe `payload` to the command as its hook stdin; null leaves stdin empty. */
function stdin(payload: object | null): void {
    const text = payload === null ? '' : JSON.stringify(payload);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((fd: unknown) => {
        if (fd !== 0) throw new Error('unexpected read');
        return text;
    }) as typeof fs.readFileSync);
}

async function run(args: string[], payload: object | null): Promise<Record<string, unknown> | undefined> {
    stdin(payload);
    await handleEvent(args);
    return sent.at(-1);
}

beforeEach(() => {
    setEnv({ KELPI_PANE_ID: PANE });
});
afterEach(() => {
    sent.length = 0;
    vi.restoreAllMocks();
    setEnv(process.env);
});

describe('kelpi event: Claude hook fields (#387)', () => {
    it('forwards last_assistant_message and transcript_path from a Stop payload', async () => {
        // The shape Claude Code pipes to a Stop hook.
        const payload = {
            session_id: SESSION,
            transcript_path: TRANSCRIPT,
            cwd: '/work/app',
            permission_mode: 'default',
            hook_event_name: 'Stop',
            stop_hook_active: false,
            last_assistant_message: 'Done. I renamed `parseFlag` and updated its 3 callers.\n\nRun `pnpm check`?'
        };
        expect(await run(['stop'], payload)).toEqual({
            command: 'stop',
            pane_id: PANE,
            session_id: SESSION,
            last_assistant_message: payload.last_assistant_message,
            transcript_path: TRANSCRIPT
        });
    });

    it.each([['permission_prompt'], ['idle_prompt']])('forwards notification_type %s', async (type) => {
        const payload = {
            session_id: SESSION,
            transcript_path: TRANSCRIPT,
            cwd: '/work/app',
            hook_event_name: 'Notification',
            message: type === 'idle_prompt' ? 'Claude is waiting for your input' : 'Claude needs your permission to use Bash',
            notification_type: type
        };
        expect(await run(['notification'], payload)).toEqual({
            command: 'notification',
            pane_id: PANE,
            title: 'Claude Code',
            body: payload.message,
            session_id: SESSION,
            notification_type: type,
            transcript_path: TRANSCRIPT
        });
    });

    it('forwards transcript_path on session-start but not on start, error or session-end', async () => {
        const payload = { session_id: SESSION, transcript_path: TRANSCRIPT, source: 'startup' };
        expect(await run(['session-start'], payload)).toEqual({
            command: 'session-start',
            pane_id: PANE,
            session_id: SESSION,
            transcript_path: TRANSCRIPT
        });
        for (const verb of ['start', 'error', 'session-end']) {
            expect(await run([verb], payload)).toEqual({ command: verb, pane_id: PANE, session_id: SESSION });
        }
    });

    it('sends only the fields a verb carries', async () => {
        const payload = { notification_type: 'idle_prompt', last_assistant_message: 'hi' };
        expect(await run(['stop'], payload)).toEqual({ command: 'stop', pane_id: PANE, last_assistant_message: 'hi' });
        expect(await run(['notification'], payload)).toEqual({
            command: 'notification',
            pane_id: PANE,
            title: 'Claude Code',
            notification_type: 'idle_prompt'
        });
    });

    it('stays wire-identical with no stdin, empty strings or wrong-typed values', async () => {
        expect(await run(['stop'], null)).toEqual({ command: 'stop', pane_id: PANE });
        expect(
            await run(['stop'], { last_assistant_message: '', transcript_path: '', notification_type: 'idle_prompt' })
        ).toEqual({ command: 'stop', pane_id: PANE });
        expect(await run(['stop'], { last_assistant_message: 42, transcript_path: null })).toEqual({
            command: 'stop',
            pane_id: PANE
        });
        expect(await run(['notification'], { notification_type: '' })).toEqual({
            command: 'notification',
            pane_id: PANE,
            title: 'Claude Code'
        });
    });

    it('caps a long reply and flags it as truncated', async () => {
        const text = 'x'.repeat(100 * 1024);
        const message = await run(['stop'], { last_assistant_message: text });
        const forwarded = message?.['last_assistant_message'] as string;
        expect(Buffer.byteLength(forwarded, 'utf8')).toBe(ASSISTANT_MESSAGE_MAX_BYTES);
        expect(text.startsWith(forwarded)).toBe(true);
        expect(message?.['last_assistant_message_truncated']).toBe(true);
    });
});

describe('kelpi event: Codex hook fields (#387)', () => {
    it('forwards tool_name and transcript_path from a PermissionRequest', async () => {
        const payload = { session_id: SESSION, transcript_path: TRANSCRIPT, tool_name: 'Bash', tool_input: { command: 'ls' } };
        expect(await run(['notification', '--agent', 'codex'], payload)).toEqual({
            command: 'notification',
            pane_id: PANE,
            title: 'Codex',
            body: 'Approval requested: Bash',
            session_id: SESSION,
            agent: 'codex',
            tool_name: 'Bash',
            transcript_path: TRANSCRIPT
        });
    });

    it('never forwards tool_name for a Claude notification', async () => {
        expect(await run(['notification'], { tool_name: 'Bash' })).toEqual({
            command: 'notification',
            pane_id: PANE,
            title: 'Claude Code'
        });
    });
});

describe('capAssistantMessage', () => {
    it('leaves a message at or under the cap untouched', () => {
        expect(capAssistantMessage('abc', 3)).toEqual({ text: 'abc', truncated: false });
        expect(capAssistantMessage('', 3)).toEqual({ text: '', truncated: false });
        const exact = 'é'.repeat(ASSISTANT_MESSAGE_MAX_BYTES / 2);
        expect(capAssistantMessage(exact)).toEqual({ text: exact, truncated: false });
    });

    it('cuts one byte over the cap and flags it', () => {
        expect(capAssistantMessage('abcd', 3)).toEqual({ text: 'abc', truncated: true });
        const over = 'a'.repeat(ASSISTANT_MESSAGE_MAX_BYTES + 1);
        expect(capAssistantMessage(over)).toEqual({ text: over.slice(0, -1), truncated: true });
    });

    it('drops a multi-byte character that straddles the cut instead of splitting it', () => {
        // 'é' is 2 bytes, '€' 3, '😀' 4 (a surrogate pair in UTF-16).
        expect(capAssistantMessage('abé', 3)).toEqual({ text: 'ab', truncated: true });
        expect(capAssistantMessage('a€b', 3)).toEqual({ text: 'a', truncated: true });
        expect(capAssistantMessage('ab😀', 5)).toEqual({ text: 'ab', truncated: true });
        expect(capAssistantMessage('ab😀c', 6)).toEqual({ text: 'ab😀', truncated: true });

        const prefix = 'a'.repeat(ASSISTANT_MESSAGE_MAX_BYTES - 2);
        const capped = capAssistantMessage(`${prefix}😀 and more`);
        expect(capped).toEqual({ text: prefix, truncated: true });
        expect(capped.text.endsWith('\uD83D')).toBe(false);
    });

    it('keeps every byte up to the cap when a character ends exactly on it', () => {
        const prefix = 'a'.repeat(ASSISTANT_MESSAGE_MAX_BYTES - 4);
        const capped = capAssistantMessage(`${prefix}😀!`);
        expect(capped).toEqual({ text: `${prefix}😀`, truncated: true });
        expect(Buffer.byteLength(capped.text, 'utf8')).toBe(ASSISTANT_MESSAGE_MAX_BYTES);
    });
});
