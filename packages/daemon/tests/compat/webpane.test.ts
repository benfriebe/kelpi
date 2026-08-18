/**
 * Web panes against the REAL Swift `nex` CLI (M6) — the **actuator + console** half.
 *
 * `ping.test.ts` covers the headless half (a pane exists, its tabs list, browser-bound verbs
 * fail honestly) and `web.test.ts` covers open / tabs / navigate / capture / exec / close. This
 * suite adds the exit-code contract of the query verbs, with a fake host (`./fakehost.ts`)
 * answering the daemon's RPCs. What it proves, and nothing else can:
 *
 *   - the CLI's exit-code semantics survive the daemon's envelope merge — `exists` exits 0/1
 *     on `found`, `attr` exits 1 when `present:false`, a `wait` timeout exits 1;
 *   - console lines the host pushes land in the daemon's ring buffer and drain back out through
 *     the shipped CLI's own `--since` / `--level` handling.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { connectFakeHost, type FakeWebHost } from './fakehost.js';
import { startCompatDaemon, swiftCLIAvailable, type CompatDaemon } from './harness.js';

describe.skipIf(!swiftCLIAvailable())('compat: web panes with a live host', () => {
    let nex: CompatDaemon;
    let shell: FakeWebHost;
    let paneID: string;

    beforeEach(async () => {
        nex = await startCompatDaemon();
        shell = await connectFakeHost(nex.info);
        const opened = await nex.run(['web', 'open', 'https://example.com'], { timeoutMs: 15_000 });
        expect(opened.code).toBe(0);
        paneID = /open ok: ([0-9A-Fa-f-]{36})/.exec(opened.stdout)?.[1] as string;
        expect(paneID).toBeDefined();
        await shell.waitForNotify('pane-open');
    }, 60_000);

    afterEach(async () => {
        shell?.close();
        await nex?.stop();
    });

    it('round-trips an actuator verb and prints the host result', async () => {
        const running = nex.run(['web', 'text', '--target', paneID, 'css:body'], { timeoutMs: 15_000 });
        const call = await shell.answer({ ok: true, text: 'hello world', truncated: false }, 'actuate');
        expect(call.args['method']).toBe('text');
        const result = await running;
        expect(result.code).toBe(0);
        expect(result.stdout.trim()).toBe('hello world');
    }, 60_000);

    it('keeps `exists` exit-code semantics (0 = found, 1 = missing)', async () => {
        const yes = nex.run(['web', 'exists', '--target', paneID, 'css:#login'], { timeoutMs: 15_000 });
        await shell.answer({ ok: true, found: true }, 'actuate');
        expect((await yes).code).toBe(0);

        const no = nex.run(['web', 'exists', '--target', paneID, 'css:#nope'], { timeoutMs: 15_000 });
        await shell.answer({ ok: true, found: false }, 'actuate');
        expect((await no).code).toBe(1);
    }, 60_000);

    it('keeps `attr` exit 1 for an absent attribute, exit 0 for an empty one', async () => {
        const absent = nex.run(['web', 'attr', '--target', paneID, 'css:#a', 'disabled'], {
            timeoutMs: 15_000
        });
        await shell.answer(
            { ok: true, name: 'disabled', value: null, present: false, truncated: false },
            'actuate'
        );
        expect((await absent).code).toBe(1);

        const empty = nex.run(['web', 'attr', '--target', paneID, 'css:#a', 'disabled'], {
            timeoutMs: 15_000
        });
        await shell.answer(
            { ok: true, name: 'disabled', value: '', present: true, truncated: false },
            'actuate'
        );
        expect((await empty).code).toBe(0);
    }, 60_000);

    it('turns a wait timeout into exit 1', async () => {
        const running = nex.run(
            ['web', 'wait', '--target', paneID, '--selector', 'css:#late', '--timeout', '1'],
            { timeoutMs: 20_000 }
        );
        await shell.answer(
            { ok: false, error: 'timeout', condition: 'exists', waited_ms: 1000 },
            'actuate'
        );
        const result = await running;
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('timeout');
    }, 60_000);

    it('drains the console buffer the host filled, honouring --since and --level', async () => {
        shell.emit('console', paneID, { level: 'log', message: 'first', url: 'https://a/' });
        shell.emit('console', paneID, { level: 'error', message: 'boom', url: 'https://a/' });
        await new Promise<void>((resolve) => setTimeout(resolve, 150));

        const all = await nex.run(['web', 'console', '--target', paneID], { timeoutMs: 15_000 });
        expect(all.code).toBe(0);
        expect(all.stdout).toContain('[0] log: first');
        expect(all.stdout).toContain('[1] error: boom');
        expect(all.stderr).toContain('(next_since=2)');

        const errorsOnly = await nex.run(
            ['web', 'console', '--target', paneID, '--level', 'error', '--json'],
            { timeoutMs: 15_000 }
        );
        const reply = JSON.parse(errorsOnly.stdout) as { lines: { message: string }[] };
        expect(reply.lines.map((line) => line.message)).toEqual(['boom']);

        const since = await nex.run(['web', 'console', '--target', paneID, '--since', '1'], {
            timeoutMs: 15_000
        });
        expect(since.stdout).not.toContain('first');
        expect(since.stdout).toContain('boom');
    }, 60_000);

    // NOTE: `web console --follow` is NOT exercised here — the shipped 0.32.0 CLI predates the
    // flag (its `web console` help lists no `--follow`), so it would silently send follow:false.
    // The streaming framing is covered against a raw control-socket client in
    // `src/webpane/integration.test.ts`.
});
