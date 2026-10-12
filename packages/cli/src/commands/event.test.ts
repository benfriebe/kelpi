import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every payload sent to the daemon. */
const sent = vi.hoisted(() => [] as Record<string, unknown>[]);
/** What the mocked request/reply send answers, and the options it was last called with. */
const replies = vi.hoisted(() => ({
    next: (): Promise<string | null> => Promise.resolve(''),
    options: [] as unknown[]
}));
vi.mock('../transport.js', async (original) => ({
    ...(await original<object>()),
    sendJSON: (payload: Record<string, unknown>) => {
        sent.push(payload);
        return Promise.resolve();
    },
    sendJSONAndReadReply: (payload: Record<string, unknown>, options: unknown) => {
        sent.push(payload);
        replies.options.push(options);
        return replies.next();
    }
}));

import { setEnv } from '../env.js';
import { ExitError, resetIO, setIO } from '../io.js';
import {
    ASSISTANT_MESSAGE_MAX_BYTES,
    PERMISSION_GUARD_MS,
    capAssistantMessage,
    handleEvent
} from './event.js';

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

describe('kelpi event permission-request (#388)', () => {
    /**
     * The stdin a real Claude Code 2.1.296 piped to a PermissionRequest hook (the #388 spike),
     * with only the home directory in `transcript_path` anonymised.
     */
    const SPIKE_STDIN = {
        session_id: '23221767-0aa0-4631-b8ff-5cec7a292080',
        transcript_path:
            '/Users/dev/.claude/projects/-private-tmp-claude-501-agent-hook-events-spike/23221767-0aa0-4631-b8ff-5cec7a292080.jsonl',
        cwd: '/private/tmp/claude-501/agent-hook-events/spike',
        scratchpad_dir:
            '/private/tmp/claude-501/-private-tmp-claude-501-agent-hook-events-spike/23221767-0aa0-4631-b8ff-5cec7a292080/scratchpad',
        prompt_id: 'f72f8395-c3cd-43ba-953b-ce7a67fe7cf2',
        permission_mode: 'default',
        effort: { level: 'medium' },
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: {
            command: 'touch /tmp/claude-501/agent-hook-events/spike/marker-silent',
            description: 'Create marker file'
        },
        permission_suggestions: [
            { type: 'addDirectories', directories: ['/tmp/claude-501/agent-hook-events/spike'], destination: 'session' },
            { type: 'setMode', mode: 'acceptEdits', destination: 'session' }
        ]
    };
    const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n';

    const out: string[] = [];
    const err: string[] = [];
    beforeEach(() => {
        replies.options.length = 0;
        setIO({ out: (text) => out.push(text), err: (text) => err.push(text) });
    });
    afterEach(() => {
        out.length = 0;
        err.length = 0;
        resetIO();
        vi.useRealTimers();
    });

    /** Run the verb against a mocked daemon reply; the exit code, 0 when it simply returns. */
    async function decide(reply: string | null, payload: object | null = SPIKE_STDIN, args: string[] = []): Promise<number> {
        replies.next = () => Promise.resolve(reply);
        stdin(payload);
        try {
            await handleEvent(['permission-request', ...args]);
            return 0;
        } catch (error) {
            if (error instanceof ExitError) return error.code;
            throw error;
        }
    }

    it('sends only the documented fields from the spike stdin, with a 3 s reply timeout', async () => {
        expect(await decide('{"ok":true,"behavior":"abstain"}')).toBe(0);
        expect(sent).toEqual([
            {
                command: 'permission-request',
                pane_id: PANE,
                tool_name: 'Bash',
                tool_input: SPIKE_STDIN.tool_input,
                cwd: SPIKE_STDIN.cwd,
                permission_mode: 'default',
                session_id: SPIKE_STDIN.session_id
            }
        ]);
        expect(replies.options).toEqual([{ timeoutSeconds: 3 }]);
    });

    it('forwards mcp_server, and sends an empty object for a missing or non-object tool_input', async () => {
        await decide('', { tool_name: 'mcp__linear__save_issue', mcp_server: 'linear', cwd: '' });
        await decide('', { tool_name: 'Bash', tool_input: ['ls'], session_id: '' });
        await decide('', { tool_name: 'Bash', tool_input: 'ls' });
        expect(sent).toEqual([
            { command: 'permission-request', pane_id: PANE, tool_name: 'mcp__linear__save_issue', tool_input: {}, mcp_server: 'linear' },
            { command: 'permission-request', pane_id: PANE, tool_name: 'Bash', tool_input: {} },
            { command: 'permission-request', pane_id: PANE, tool_name: 'Bash', tool_input: {} }
        ]);
    });

    it('prints the allow decision', async () => {
        expect(await decide('{"ok":true,"behavior":"allow","provider":"example.auto-approve"}\n')).toBe(0);
        expect(out.join('')).toBe(ALLOW);
    });

    it('prints the deny decision with its message', async () => {
        expect(await decide('{"ok":true,"behavior":"deny","message":"rm -rf is never approved"}')).toBe(0);
        expect(out.join('')).toBe(
            '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"rm -rf is never approved"}}}\n'
        );
    });

    it.each([['{"ok":true,"behavior":"deny"}'], ['{"ok":true,"behavior":"deny","message":""}']])(
        'omits message from a deny without one: %s',
        async (reply) => {
            expect(await decide(reply)).toBe(0);
            expect(out.join('')).toBe('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}\n');
        }
    );

    it.each([
        ['abstain', '{"ok":true,"behavior":"abstain"}'],
        ['an unknown behavior', '{"ok":true,"behavior":"ask"}'],
        ['ok:false', '{"ok":false,"error":"unknown pane"}'],
        ['a reply without ok', '{"behavior":"allow"}'],
        ['an empty reply', ''],
        ['a garbage reply', 'not json'],
        ['a transport failure', null]
    ])('prints nothing and exits 0 on %s', async (_name, reply) => {
        expect(await decide(reply)).toBe(0);
        expect(sent).toHaveLength(1);
        expect(out).toEqual([]);
        expect(err).toEqual([]);
    });

    it('warns on stderr only under KELPI_VERBOSE_HOOKS, and still prints nothing', async () => {
        setEnv({ KELPI_PANE_ID: PANE, KELPI_VERBOSE_HOOKS: '1' });
        expect(await decide('{"ok":false,"error":"unknown pane"}')).toBe(0);
        expect(out).toEqual([]);
        expect(err.join('')).toBe('Warning: kelpi event permission-request: unknown pane\n');
    });

    it('sends nothing and prints nothing for --agent codex', async () => {
        expect(await decide('{"ok":true,"behavior":"allow"}', SPIKE_STDIN, ['--agent', 'codex'])).toBe(0);
        expect(sent).toEqual([]);
        expect(out).toEqual([]);
    });

    it.each([
        ['no tool_name', { ...SPIKE_STDIN, tool_name: undefined }],
        ['an empty tool_name', { ...SPIKE_STDIN, tool_name: '' }],
        ['a non-string tool_name', { ...SPIKE_STDIN, tool_name: 7 }],
        ['no stdin', null]
    ])('sends nothing with %s', async (_name, payload) => {
        expect(await decide('{"ok":true,"behavior":"allow"}', payload)).toBe(0);
        expect(sent).toEqual([]);
        expect(out).toEqual([]);
    });

    it('exits 0 silently outside a pane', async () => {
        setEnv({});
        expect(await decide('{"ok":true,"behavior":"allow"}')).toBe(0);
        expect(sent).toEqual([]);
        expect(out).toEqual([]);
    });

    it('exits 0 with nothing printed when no decision comes within 3.5 s', async () => {
        vi.useFakeTimers();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);
        replies.next = () => new Promise<string | null>(() => undefined);
        stdin(SPIKE_STDIN);
        void handleEvent(['permission-request']);

        await vi.advanceTimersByTimeAsync(PERMISSION_GUARD_MS - 1);
        expect(sent).toHaveLength(1);
        expect(exitSpy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(exitSpy).toHaveBeenCalledWith(0);
        expect(out).toEqual([]);
    });

    it('clears the guard once decided, so a fast answer does not keep the process alive', async () => {
        vi.useFakeTimers();
        expect(await decide('{"ok":true,"behavior":"allow"}')).toBe(0);
        expect(out.join('')).toBe(ALLOW);
        expect(vi.getTimerCount()).toBe(0);
        expect(await decide(null)).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
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
        // A lone surrogate is 3 bytes, as Buffer writes it as U+FFFD.
        expect(capAssistantMessage('a\uD800b', 4)).toEqual({ text: 'a\uD800', truncated: true });

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
