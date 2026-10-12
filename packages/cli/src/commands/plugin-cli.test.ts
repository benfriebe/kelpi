import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every request sent to the daemon, with the `KELPI_ROUTE_RETRY_MS` in force when it was sent,
 * and the canned replies handed back in order (null: unreachable).
 */
const sent = vi.hoisted(
    () => [] as { payload: Record<string, unknown>; timeoutSeconds: number | undefined; routeRetryMs: string | undefined }[]
);
const replies = vi.hoisted(() => [] as (string | null)[]);
vi.mock('../transport.js', async (original) => {
    const { env } = await import('../env.js');
    return {
        ...(await original<object>()),
        sendJSONAndReadReply: (payload: Record<string, unknown>, options: { timeoutSeconds?: number } = {}) => {
            sent.push({ payload, timeoutSeconds: options.timeoutSeconds, routeRetryMs: env()['KELPI_ROUTE_RETRY_MS'] });
            return Promise.resolve(replies.length > 0 ? replies.shift() : null);
        }
    };
});

import { env, setEnv } from '../env.js';
import { resetIO, setIO } from '../io.js';
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
    resetIO();
    setEnv(process.env);
});

function answer(reply: object | null): void {
    replies.push(reply === null ? null : JSON.stringify(reply));
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

    it('should name the verb before any other daemon error, such as a disabled plugin', async () => {
        answer({ ok: false, error: 'plugin acme.x is disabled' });
        await expect(handlePluginVerb('hello', [])).rejects.toMatchObject({ code: 1 });
        expect(err).toBe('kelpi hello: plugin acme.x is disabled\n');
    });

    it('should never ask the daemon about a word starting with -', async () => {
        await expect(handlePluginVerb('--bogus', [])).rejects.toMatchObject({ code: 1 });
        expect(sent).toEqual([]);
        expect(err).toBe(`Unknown command: --bogus\n${globalUsage}`);
    });

    it('should say plugin verbs need a daemon when none can be reached', async () => {
        answer(null);
        await expect(handlePluginVerb('frobnicate', [])).rejects.toMatchObject({ code: 1 });
        const lines = err.split('\n');
        expect(lines[0]).toBe('Unknown command: frobnicate');
        expect(lines[1]).toMatch(/^Plugin verbs need a running Kelpi daemon/);
        expect(err.endsWith(globalUsage)).toBe(true);
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

    it('should show nothing for an empty list, no daemon, an error or a malformed reply', async () => {
        answer({ ok: true, result: { verbs: [] } });
        answer(null);
        answer({ ok: false, error: 'missing or invalid pluginID' });
        replies.push('');
        answer({ ok: true, result: { verbs: [{ name: 'hello' }] } });
        for (let index = 0; index < 5; index += 1) expect(await pluginVerbsHelp()).toBe('');
    });
});
