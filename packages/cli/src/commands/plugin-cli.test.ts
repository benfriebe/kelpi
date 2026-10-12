import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every request sent to the daemon, with the `KELPI_ROUTE_RETRY_MS` in force when it was sent,
 * and the canned replies handed back in order (null: unreachable, with the failure the transport
 * would record, if any).
 */
const sent = vi.hoisted(
    () =>
        [] as {
            payload: Record<string, unknown>;
            timeoutSeconds: number | undefined;
            deadlineMs: number | undefined;
            routeRetryMs: string | undefined;
        }[]
);
const replies = vi.hoisted(() => [] as (string | null)[]);
const failures = vi.hoisted(() => [] as (TransportFailure | null)[]);
vi.mock('../transport.js', async (original) => {
    const { env } = await import('../env.js');
    const actual = await original<typeof import('../transport.js')>();
    return {
        ...actual,
        sendJSONAndReadReply: (payload: Record<string, unknown>, options: { timeoutSeconds?: number; deadlineMs?: number } = {}) => {
            sent.push({ payload, timeoutSeconds: options.timeoutSeconds, deadlineMs: options.deadlineMs, routeRetryMs: env()['KELPI_ROUTE_RETRY_MS'] });
            const reply = replies.length > 0 ? replies.shift() : null;
            actual.setLastTransportFailure(reply === null ? (failures.shift() ?? null) : null);
            return Promise.resolve(reply);
        }
    };
});

import { env, setEnv } from '../env.js';
import { resetIO, setIO } from '../io.js';
import type { TransportFailure } from '../transport.js';
import { globalUsage, pluginVerbsUsage } from '../usage.js';
import { handlePluginVerb, pluginVerbsHelp, splitJsonSwitch } from './plugin-cli.js';

let out = '';
let err = '';

beforeEach(() => {
    out = '';
    err = '';
    setIO({ out: (text) => (out += text), err: (text) => (err += text) });
    setEnv({ KELPI_PANE_ID: 'PANE-1' });
});
afterEach(() => {
    sent.length = 0;
    replies.length = 0;
    failures.length = 0;
    vi.restoreAllMocks();
    resetIO();
    setEnv(process.env);
});

function answer(reply: object | null, failure: TransportFailure | null = null): void {
    replies.push(reply === null ? null : JSON.stringify(reply));
    if (reply === null) failures.push(failure);
}

function sentInput(index = 0): Record<string, unknown> {
    return JSON.parse(String(sent[index]?.payload['text'])) as Record<string, unknown>;
}

describe('kelpi <plugin verb>', () => {
    it('should send one cli request with argv, cwd, isTTY and the caller pane, print text and exit with exitCode', async () => {
        answer({ ok: true, result: { text: 'hello a b', exitCode: 3 } });
        await expect(handlePluginVerb('hello', ['a', 'b'])).rejects.toMatchObject({ code: 3 });
        expect(sent).toHaveLength(1);
        expect(sent[0]?.payload).toMatchObject({ command: 'plugin', action: 'cli' });
        expect(sent[0]?.timeoutSeconds).toBe(35);
        expect(sent[0]?.deadlineMs).toBeUndefined();
        expect(sentInput()).toEqual({
            verb: 'hello',
            argv: ['a', 'b'],
            cwd: process.cwd(),
            isTTY: process.stdout.isTTY === true,
            json: false,
            paneID: 'PANE-1'
        });
        expect(out).toBe('hello a b\n');
        expect(err).toBe('');
    });

    it('should leave out paneID outside a pane, exit 0 without an exitCode and send stderr to stderr', async () => {
        setEnv({});
        answer({ ok: true, result: { text: 'done\n', stderr: 'careful' } });
        await expect(handlePluginVerb('hello', [])).rejects.toMatchObject({ code: 0 });
        expect(sentInput()).not.toHaveProperty('paneID');
        expect(out).toBe('done\n');
        expect(err).toBe('careful\n');
    });

    it('should treat an exitCode that is not a process exit code as a failure', async () => {
        for (const exitCode of [-1, 256, 1.5, '3']) {
            answer({ ok: true, result: { exitCode } });
            await expect(handlePluginVerb('hello', [])).rejects.toMatchObject({ code: 1 });
        }
    });

    it('should print nothing for a result with no text, and wrap a non-object result as {}', async () => {
        answer({ ok: true, result: { json: { a: 1 } } });
        await expect(handlePluginVerb('hello', [])).rejects.toMatchObject({ code: 0 });
        answer({ ok: true, result: 'stray' });
        await expect(handlePluginVerb('hello', [])).rejects.toMatchObject({ code: 0 });
        expect(out).toBe('');
    });

    it('should pop --json, send json:true and print the json field indented', async () => {
        answer({ ok: true, result: { text: 'ignored', json: { argv: ['a'] } } });
        await expect(handlePluginVerb('hello', ['--json', 'a'])).rejects.toMatchObject({ code: 0 });
        expect(sentInput()).toMatchObject({ argv: ['a'], json: true });
        expect(out).toBe(`${JSON.stringify({ argv: ['a'] }, null, 2)}\n`);
    });

    it('should print { "text": ... } under --json when the result has only text', async () => {
        answer({ ok: true, result: { text: 'hello' } });
        await expect(handlePluginVerb('hello', ['a', '--json'])).rejects.toMatchObject({ code: 0 });
        expect(out).toBe(`${JSON.stringify({ text: 'hello' }, null, 2)}\n`);
    });

    it('should keep --json after a -- separator in argv', () => {
        expect(splitJsonSwitch(['--json', 'a', '--json', '--', '--json', 'b'])).toEqual({ argv: ['a', '--', '--json', 'b'], json: true });
        expect(splitJsonSwitch(['a', '--', '--json'])).toEqual({ argv: ['a', '--', '--json'], json: false });
        expect(splitJsonSwitch([])).toEqual({ argv: [], json: false });
    });

    it('should pass --help through to the plugin as argv', async () => {
        answer({ ok: true, result: { text: 'usage: hello [names...]' } });
        await expect(handlePluginVerb('hello', ['--help'])).rejects.toMatchObject({ code: 0 });
        expect(sentInput()).toMatchObject({ argv: ['--help'], json: false });
        expect(out).toBe('usage: hello [names...]\n');
    });

    it('should report a word no plugin declares exactly as an unknown command', async () => {
        answer({ ok: false, error: 'unknown kelpi verb: frobnicate' });
        await expect(handlePluginVerb('frobnicate', [])).rejects.toMatchObject({ code: 1 });
        expect(err).toBe(`Unknown command: frobnicate\n${globalUsage}`);
        expect(out).toBe('');
    });

    it("should print a handler's own unknown-verb error as an error, not as an unknown command", async () => {
        answer({ ok: false, error: 'unknown kelpi verb: hello sub' });
        await expect(handlePluginVerb('hello', ['sub'])).rejects.toMatchObject({ code: 1 });
        expect(err).toBe('kelpi hello: unknown kelpi verb: hello sub\n');
    });

    it('should name the verb before any other daemon error, such as a disabled plugin', async () => {
        answer({ ok: false, error: 'plugin acme.x is disabled' });
        await expect(handlePluginVerb('hello', [])).rejects.toMatchObject({ code: 1 });
        expect(err).toBe('kelpi hello: plugin acme.x is disabled\n');
    });

    it('should never ask the daemon about a word no plugin could declare', async () => {
        for (const word of ['--bogus', '-x', '', 'Hello', 'two words', 'a'.repeat(33), '9lives']) {
            err = '';
            await expect(handlePluginVerb(word, [])).rejects.toMatchObject({ code: 1 });
            expect(err).toBe(`Unknown command: ${word}\n${globalUsage}`);
        }
        expect(sent).toEqual([]);
    });

    it('should still ask about a word of exactly 32 characters', async () => {
        answer({ ok: true, result: {} });
        await expect(handlePluginVerb('a'.repeat(32), [])).rejects.toMatchObject({ code: 0 });
        expect(sent).toHaveLength(1);
    });

    it('should say plugin verbs need a daemon when none can be reached', async () => {
        answer(null, { kind: 'tcpConnectFailed', host: '127.0.0.1', port: 1, errno: 61, message: 'Connection refused' });
        await expect(handlePluginVerb('frobnicate', [])).rejects.toMatchObject({ code: 1 });
        const lines = err.split('\n');
        expect(lines[0]).toBe('Unknown command: frobnicate');
        expect(lines[1]).toMatch(/^Plugin verbs need a running Kelpi daemon/);
        expect(err.endsWith(globalUsage)).toBe(true);
    });

    it('should say no response, not unknown command, when the socket failed after connecting', async () => {
        answer(null, { kind: 'emptyReply', command: 'plugin' });
        await expect(handlePluginVerb('hello', [])).rejects.toMatchObject({ code: 1 });
        expect(err).toBe('kelpi hello: no response from Kelpi\n');
    });

    it('should print the route error a built-in prints when the harness guard refuses the socket', async () => {
        answer(null, { kind: 'requiredSocketUnmet', raw: undefined });
        await expect(handlePluginVerb('hello', [])).rejects.toMatchObject({ code: 1 });
        const lines = err.split('\n');
        expect(lines[0]).toMatch(/^Error: kelpi hello: KELPI_REQUIRE_SOCKET is set but KELPI_SOCKET names no tcp route/);
        expect(lines[1]).toMatch(/^Repair: /);
        expect(err).not.toContain('Unknown command');
    });

    it('should send PWD, then the home directory, as cwd when the working directory is gone', async () => {
        vi.spyOn(process, 'cwd').mockImplementation(() => {
            throw Object.assign(new Error('ENOENT: process.cwd failed'), { code: 'ENOENT' });
        });
        setEnv({ PWD: '/gone/worktree', HOME: '/home/someone' });
        answer({ ok: true, result: {} });
        await expect(handlePluginVerb('hello', [])).rejects.toMatchObject({ code: 0 });
        expect(sentInput(0)['cwd']).toBe('/gone/worktree');
        setEnv({ PWD: '', HOME: '/home/someone' });
        answer({ ok: true, result: {} });
        await expect(handlePluginVerb('hello', [])).rejects.toMatchObject({ code: 0 });
        expect(sentInput(1)['cwd']).toBe('/home/someone');
    });

    it('should keep the pane-route retry for a verb, like a built-in command', async () => {
        answer({ ok: true, result: {} });
        await expect(handlePluginVerb('hello', [])).rejects.toMatchObject({ code: 0 });
        expect(sent[0]?.routeRetryMs).toBeUndefined();
    });

    it('should treat a daemon from before plugin verbs as having none', async () => {
        answer({ ok: false, error: 'missing or invalid pluginID' });
        await expect(handlePluginVerb('frobnicate', [])).rejects.toMatchObject({ code: 1 });
        expect(err.startsWith('Unknown command: frobnicate\nThe running Kelpi daemon predates plugin verbs')).toBe(true);
    });

    it('should fail on an empty or malformed reply', async () => {
        replies.push('');
        await expect(handlePluginVerb('hello', [])).rejects.toMatchObject({ code: 1 });
        replies.push('not json');
        await expect(handlePluginVerb('hello', [])).rejects.toMatchObject({ code: 1 });
        expect(err).toBe('kelpi hello: no response from Kelpi (upgrade required?)\nkelpi hello: invalid JSON response\n');
    });
});

describe('kelpi --help plugin block', () => {
    const verbs = [
        { name: 'hello', summary: 'Say hello', command: 'lab.hello', pluginID: 'lab.service', pluginName: 'Service Lab', enabled: true },
        { name: 'auto-approve', summary: "Answer Claude's Bash prompts for a set time", command: 'acme.aa', pluginID: 'acme.aa', pluginName: 'Acme', enabled: false },
        { name: 'echo', summary: 'Echo argv', command: 'lab.echo', pluginID: 'lab.service', pluginName: 'Service Lab', enabled: true }
    ];

    it('should group verbs by plugin, align summaries and mark disabled ones', async () => {
        answer({ ok: true, result: { verbs } });
        expect(await pluginVerbsHelp()).toBe(
            [
                'Plugin commands:',
                '  # Acme',
                "  kelpi auto-approve (disabled)  Answer Claude's Bash prompts for a set time",
                '  # Service Lab',
                '  kelpi echo                     Echo argv',
                '  kelpi hello                    Say hello',
                '',
                ''
            ].join('\n')
        );
        expect(sent[0]?.payload).toEqual({ command: 'plugin', action: 'cli-list', text: '{}' });
        expect(sent[0]?.timeoutSeconds).toBe(2);
        expect(sent[0]?.deadlineMs).toBe(2000);
    });

    it('should turn the pane-route retry off for the help request only, unless it is set explicitly', async () => {
        await pluginVerbsHelp();
        expect(sent[0]?.routeRetryMs).toBe('0');
        expect(env()['KELPI_ROUTE_RETRY_MS']).toBeUndefined();
        setEnv({ KELPI_PANE_ID: 'PANE-1', KELPI_ROUTE_RETRY_MS: '3000' });
        await pluginVerbsHelp();
        expect(sent[1]?.routeRetryMs).toBe('3000');
    });

    it('should render one verb as kelpi <name>, two spaces, then its summary', () => {
        expect(pluginVerbsUsage([{ name: 'hello', summary: 'Say hello', pluginID: 'p', pluginName: 'P', enabled: true }])).toContain(
            '\n  kelpi hello  Say hello\n'
        );
    });

    it('should drop control characters from plugin names and summaries', () => {
        const block = pluginVerbsUsage([{ name: 'hello', summary: 'Say \u001b[31mhello\u009b', pluginID: 'p', pluginName: 'Evil\nPlugin', enabled: true }]);
        expect(block).toBe('Plugin commands:\n  # EvilPlugin\n  kelpi hello  Say [31mhello\n\n');
    });

    it('should show nothing for an empty list, no daemon, an error or a malformed reply', async () => {
        answer({ ok: true, result: { verbs: [] } });
        answer(null);
        answer({ ok: false, error: 'missing or invalid pluginID' });
        replies.push('');
        answer({ ok: true, result: { verbs: [{ name: 'hello' }] } });
        for (let index = 0; index < 5; index += 1) expect(await pluginVerbsHelp()).toBe('');
    });
});
