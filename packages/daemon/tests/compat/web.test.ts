/**
 * `kelpi web …` against the REAL Swift CLI, with a host attached (M6).
 *
 * Three suites now cover web panes, deliberately split by what each one can prove:
 *
 *   - `ping.test.ts` — the **headless** half: panes, tabs and console buffers are daemon state,
 *     so they work with no host at all, and browser-bound verbs fail with a stable string.
 *   - this file + `webpane.test.ts` — the **wire contract** with a host in the loop: a fake host
 *     (`./fakehost.ts`) speaking `src/webpane/HOST_PROTOCOL.md` answers the daemon's `host-rpc`
 *     frames, so every assertion can look at both ends at once — what the shipped CLI printed
 *     and exited with, and what the daemon asked the host to do (verb, tab id, normalized URL).
 *   - `packages/shell/scripts/web-smoke.mjs` — the **real** host: Electron, real
 *     `WebContentsView`s, real CDP, driven by the same shipped CLI (41 checks, run manually with
 *     `pnpm --filter @kelpi/shell smoke:web`).
 *
 * The fake host is what belongs in a vitest run: it needs no GUI session, no Electron download
 * and no built shell bundle, and it makes host answers *deterministic*, so timing-dependent
 * page behaviour can never turn a wire-contract regression into a flake. Everything a real
 * browser must do to be a correct host is asserted in the shell smoke instead.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { connectFakeHost, type FakeWebHost, type JsonRecord } from './fakehost.js';
import {
    startCompatDaemon,
    swiftCLIAvailable,
    type CompatDaemon,
    type PaneListEntryJSON
} from './harness.js';

interface TabJSON {
    readonly id: string;
    readonly index: number;
    readonly url: string;
    readonly title: string;
    readonly active: boolean;
}

const DATA_URL = 'data:text/html,<h1>compat</h1>';

describe.skipIf(!swiftCLIAvailable())('compat: web panes with a host', () => {
    let kelpi: CompatDaemon;
    let host: FakeWebHost;

    /** `web open` + the pane id the CLI printed. */
    async function open(url: string, extra: readonly string[] = []): Promise<string> {
        const opened = await kelpi.run(['web', 'open', ...extra, url], { timeoutMs: 15_000 });
        expect(opened.code, opened.stderr).toBe(0);
        const paneID = /open ok: ([0-9A-Fa-f-]{36})/.exec(opened.stdout)?.[1];
        expect(paneID, opened.stdout).toBeDefined();
        return paneID as string;
    }

    async function tabs(paneID: string): Promise<readonly TabJSON[]> {
        return kelpi.json<TabJSON[]>(['web', 'tabs', '--target', paneID, '--json']);
    }

    beforeEach(async () => {
        kelpi = await startCompatDaemon();
        host = await connectFakeHost(kelpi.info);
    }, 60_000);

    afterEach(async () => {
        host?.close();
        await kelpi?.stop();
    });

    // ── open ────────────────────────────────────────────────────────────────

    it('opens a pane for a data: URL and mirrors it onto the host', async () => {
        const paneID = await open(DATA_URL);

        const panes = await kelpi.json<PaneListEntryJSON[]>(['pane', 'list', '--json']);
        expect(panes.find((pane) => pane.id === paneID)?.type).toBe('web');

        const listed = await tabs(paneID);
        expect(listed).toHaveLength(1);
        // A `data:` URL keeps its opaque scheme — normalizeURLInput must not https:// it.
        expect(listed[0]).toMatchObject({ index: 0, active: true, url: DATA_URL });

        // §3.1: the host learns about the pane through a fire-and-forget `pane-open`.
        const opened = await host.waitForNotify(
            'pane-open',
            (args) => String(args['paneID']).toUpperCase() === paneID.toUpperCase()
        );
        expect(opened.args['isPrivate']).toBe(false);
        expect(opened.args['activeTabID']).toBe(listed[0]?.id);
        expect(opened.args['tabs']).toEqual([
            { id: listed[0]?.id, url: DATA_URL, title: listed[0]?.title ?? '' }
        ]);
    }, 60_000);

    it('carries --private into the host notification', async () => {
        const paneID = await open('https://example.com', ['--private']);
        const opened = await host.waitForNotify(
            'pane-open',
            (args) => String(args['paneID']).toUpperCase() === paneID.toUpperCase()
        );
        expect(opened.args['isPrivate']).toBe(true);
    }, 60_000);

    it('resolves a local file argument to a file:// URL before the daemon sees it', async () => {
        // CLI-side `localFileURL` (cli.md §13.2): a bare name matching a regular file WITH an
        // extension in the cwd becomes a percent-encoded file:// URL. The daemon must accept it
        // verbatim — a `file:` scheme has no `://` until the CLI rewrites it, and
        // `normalizeURLInput` would otherwise treat it as a hostname.
        const site = path.join(kelpi.home, 'site');
        fs.mkdirSync(site, { recursive: true });
        fs.writeFileSync(path.join(site, 'page one.html'), '<h1>local</h1>\n');

        const opened = await kelpi.run(['web', 'open', 'page one.html'], {
            cwd: site,
            timeoutMs: 15_000
        });
        expect(opened.code, opened.stderr).toBe(0);
        const paneID = /open ok: ([0-9A-Fa-f-]{36})/.exec(opened.stdout)?.[1] as string;

        const listed = await tabs(paneID);
        const url = listed[0]?.url ?? '';
        expect(url.startsWith('file:///')).toBe(true);
        expect(url.endsWith('/page%20one.html')).toBe(true);
        expect(url).toContain(path.basename(site));
    }, 60_000);

    // ── tabs ────────────────────────────────────────────────────────────────

    it('drives the tab lifecycle end to end (new → select → close)', async () => {
        const paneID = await open('https://example.com');
        await host.waitForNotify('pane-open');

        const created = await kelpi.run(
            ['web', 'tab-new', '--target', paneID, 'https://second.example'],
            { timeoutMs: 15_000 }
        );
        expect(created.code, created.stderr).toBe(0);
        expect(created.stdout).toContain('https://second.example');

        const two = await tabs(paneID);
        expect(two.map((tab) => [tab.index, tab.active, tab.url])).toEqual([
            [0, false, 'https://example.com'],
            [1, true, 'https://second.example']
        ]);
        const opened = await host.waitForNotify('tab-open');
        expect(opened.args).toMatchObject({
            paneID,
            tabID: two[1]?.id,
            url: 'https://second.example',
            makeActive: true
        });

        // `--no-focus` opens in the background: daemon state and the host agree it is not active.
        const background = await kelpi.run(
            ['web', 'tab-new', '--target', paneID, '--no-focus', 'https://third.example'],
            { timeoutMs: 15_000 }
        );
        expect(background.code, background.stderr).toBe(0);
        const three = await tabs(paneID);
        expect(three.map((tab) => tab.active)).toEqual([false, true, false]);
        expect(host.notifiesOf('tab-open')[1]?.args['makeActive']).toBe(false);

        // Tab refs are a numeric index or a tab UUID; both are the daemon's resolution.
        const selected = await kelpi.run(['web', 'tab-select', '--target', paneID, '0'], {
            timeoutMs: 15_000
        });
        expect(selected.code, selected.stderr).toBe(0);
        expect((await tabs(paneID)).map((tab) => tab.active)).toEqual([true, false, false]);
        expect(host.notifiesOf('tab-select')[0]?.args).toMatchObject({
            paneID,
            tabID: three[0]?.id
        });

        const closed = await kelpi.run(
            ['web', 'tab-close', '--target', paneID, three[2]?.id as string],
            { timeoutMs: 15_000 }
        );
        expect(closed.code, closed.stderr).toBe(0);
        const remaining = await tabs(paneID);
        expect(remaining.map((tab) => tab.url)).toEqual([
            'https://example.com',
            'https://second.example'
        ]);
        expect(host.notifiesOf('tab-close')[0]?.args).toMatchObject({
            paneID,
            tabID: three[2]?.id
        });

        // A bad ref is refused by the daemon, with the reason the CLI prints verbatim.
        const outOfRange = await kelpi.run(['web', 'tab-select', '--target', paneID, '9'], {
            timeoutMs: 15_000
        });
        expect(outOfRange.code).toBe(1);
        expect(outOfRange.stderr).toContain('tab index 9 out of range (0..<2)');
    }, 90_000);

    // ── navigate ────────────────────────────────────────────────────────────

    it('navigates the active tab through the host and writes the URL into daemon state', async () => {
        const paneID = await open('https://example.com');
        const before = await tabs(paneID);
        host.on('navigate', () => ({ ok: true }));

        // A bare hostname is normalized daemon-side (§7.6) before it reaches the host.
        const navigated = await kelpi.run(['web', 'navigate', '--target', paneID, 'example.org/docs'], {
            timeoutMs: 15_000
        });
        expect(navigated.code, navigated.stderr).toBe(0);
        expect(navigated.stdout).toContain('navigate ok:');

        const call = host.callsOf('navigate')[0];
        expect(call?.args).toMatchObject({
            paneID,
            tabID: before[0]?.id,
            url: 'https://example.org/docs'
        });
        // §4.2: the daemon writes the normalized URL optimistically, so state moves on the ack.
        expect((await tabs(paneID))[0]?.url).toBe('https://example.org/docs');
    }, 60_000);

    it('turns a host navigation failure into exit 1 with the host\'s own message', async () => {
        const paneID = await open('https://example.com');
        host.on('navigate', () => ({ ok: false, error: 'ERR_NAME_NOT_RESOLVED' }));

        const failed = await kelpi.run(['web', 'navigate', '--target', paneID, 'https://nope.invalid'], {
            timeoutMs: 15_000
        });
        expect(failed.code).toBe(1);
        expect(failed.stderr).toContain('ERR_NAME_NOT_RESOLVED');
        expect(failed.stdout).toBe('');
    }, 60_000);

    it('reports the host\'s live url/title, and falls back to state when it cannot', async () => {
        const paneID = await open('https://example.com');
        host.on('url', () => ({ ok: true, url: 'https://example.com/after', title: 'Live Title' }));

        const live = await kelpi.run(['web', 'url', '--target', paneID], { timeoutMs: 15_000 });
        expect(live.code, live.stderr).toBe(0);
        expect(live.stdout.trim()).toBe('https://example.com/after\tLive Title');

        // §8.2: a host that answers ok:false is not an error — the daemon serves its own copy.
        host.on('url', () => ({ ok: false, error: 'view is gone' }));
        const fallback = await kelpi.run(['web', 'url', '--target', paneID], { timeoutMs: 15_000 });
        expect(fallback.code, fallback.stderr).toBe(0);
        expect(fallback.stdout.trim()).toBe('https://example.com');
    }, 60_000);

    // ── capture ─────────────────────────────────────────────────────────────

    it('renders each capture mode the shipped CLI can ask for', async () => {
        const paneID = await open('https://example.com');
        host.on('capture', (call) => {
            const mode = String(call.args['mode']);
            const base = { ok: true, url: 'https://example.com/live', title: 'Example Domain' };
            if (mode === 'text') return { ...base, text: 'hello compat', byte_count: 12 };
            if (mode === 'screenshot') return { ...base, png_base64: 'iVBORw0KGgo=', byte_count: 9 };
            return { ...base, byte_count: 0 };
        });

        const text = await kelpi.run(['web', 'capture', '--target', paneID, '--mode', 'text'], {
            timeoutMs: 15_000
        });
        expect(text.code, text.stderr).toBe(0);
        // `text` prints the text and nothing else — the mode agents pipe into a file.
        expect(text.stdout.trim()).toBe('hello compat');
        expect(host.callsOf('capture')[0]?.args).toMatchObject({ paneID, mode: 'text' });

        const screenshot = await kelpi.run(
            ['web', 'capture', '--target', paneID, '--mode', 'screenshot'],
            { timeoutMs: 15_000 }
        );
        // No `path` in the envelope ⇒ the base64 payload is what a caller pipes to `base64 -D`.
        expect(screenshot.stdout.trim()).toBe('iVBORw0KGgo=');

        // Default mode is `meta`, rendered as labelled lines from the host's LIVE values.
        const meta = await kelpi.run(['web', 'capture', '--target', paneID], { timeoutMs: 15_000 });
        expect(meta.stdout).toContain('url:');
        expect(meta.stdout).toContain('https://example.com/live');
        expect(meta.stdout).toContain('Example Domain');
        expect(host.callsOf('capture').at(-1)?.args['mode']).toBe('meta');
    }, 90_000);

    it('has no --json on capture in 0.32.0 (the flag is silently ignored)', async () => {
        // DELTA, recorded in ../kelpi-docs/compat-status.md: `cli.md` §15.6 documents `--mode dom|all`
        // and a `--json` envelope dump, but the SHIPPED 0.32.0 binary offers neither — its help
        // lists `--mode meta|text|screenshot` only, and its capture parser drops unknown flags
        // instead of rejecting them. The daemon accepts the full documented mode set
        // (`webpane/handlers.ts` CAPTURE_MODES, unit-tested in `handlers.test.ts`); only the
        // client half is behind.
        const paneID = await open('https://example.com');
        host.on('capture', () => ({
            ok: true,
            url: 'https://example.com/live',
            title: 'Example Domain',
            text: 'hello compat',
            byte_count: 12
        }));

        const ignored = await kelpi.run(
            ['web', 'capture', '--target', paneID, '--mode', 'text', '--json'],
            { timeoutMs: 15_000 }
        );
        expect(ignored.code, ignored.stderr).toBe(0);
        expect(ignored.stdout.trim()).toBe('hello compat');

        for (const mode of ['dom', 'all', 'pdf']) {
            const calls = host.callsOf('capture').length;
            const rejected = await kelpi.run(
                ['web', 'capture', '--target', paneID, '--mode', mode],
                { timeoutMs: 15_000 }
            );
            expect(rejected.code).toBe(1);
            expect(rejected.stderr).toContain(
                `unknown --mode '${mode}' (allowed: meta, text, screenshot)`
            );
            // Client-side refusal: no socket traffic at all.
            expect(host.callsOf('capture')).toHaveLength(calls);
        }
    }, 90_000);

    it('merges the daemon\'s identity fields onto a host envelope (--json on an actuator verb)', async () => {
        // `capture --json` is missing from 0.32.0 (above), so the envelope merge documented in
        // HOST_PROTOCOL §2 is pinned through a verb the shipped CLI *does* dump: `web text`.
        const paneID = await open('https://example.com');
        const [tab] = await tabs(paneID);
        host.on('actuate', () => ({ ok: true, text: 'hello compat', truncated: false }));

        const json = await kelpi.json<JsonRecord>([
            'web',
            'text',
            '--target',
            paneID,
            'css:body',
            '--json'
        ]);
        expect(json).toMatchObject({
            ok: true,
            text: 'hello compat',
            truncated: false,
            pane_id: paneID,
            tab_id: tab?.id
        });
        expect(String(json['workspace_id'])).toMatch(/^[0-9A-F-]{36}$/);
    }, 60_000);

    // ── exec ────────────────────────────────────────────────────────────────

    it('round-trips exec results and renders each JSON type the CLI special-cases', async () => {
        const paneID = await open('https://example.com');
        const scripts: JsonRecord = {
            'document.title': 'Example Domain',
            '1 + 1': 2,
            'true': true,
            'null': null,
            'kelpi.meta()': { title: 'Example Domain', width: 800 }
        };
        host.on('exec', (call) => ({ ok: true, result: scripts[String(call.args['script'])] ?? null }));

        const title = await kelpi.run(['web', 'exec', '--target', paneID, 'document.title'], {
            timeoutMs: 15_000
        });
        expect(title.code, title.stderr).toBe(0);
        // Strings print raw (no quotes) — agents pipe this straight into shell variables.
        expect(title.stdout.trim()).toBe('Example Domain');
        expect(host.callsOf('exec')[0]?.args['script']).toBe('document.title');

        expect((await kelpi.run(['web', 'exec', '--target', paneID, '1 + 1'])).stdout.trim()).toBe('2');
        expect((await kelpi.run(['web', 'exec', '--target', paneID, 'true'])).stdout.trim()).toBe('true');
        // A null result prints nothing at all.
        expect((await kelpi.run(['web', 'exec', '--target', paneID, 'null'])).stdout.trim()).toBe('');

        const object = await kelpi.run(['web', 'exec', '--target', paneID, 'kelpi.meta()']);
        expect(JSON.parse(object.stdout) as JsonRecord).toEqual({
            title: 'Example Domain',
            width: 800
        });
    }, 90_000);

    it('surfaces a JS error as exit 1, and still prints the envelope under --json', async () => {
        const paneID = await open('https://example.com');
        host.on('exec', () => ({
            ok: false,
            error: 'ReferenceError: nope is not defined',
            js_error: { name: 'ReferenceError', message: 'nope is not defined', line: 1, column: 7 }
        }));

        const plain = await kelpi.run(['web', 'exec', '--target', paneID, 'return nope'], {
            timeoutMs: 15_000
        });
        expect(plain.code).toBe(1);
        expect(plain.stderr).toContain('ReferenceError: nope is not defined');
        expect(plain.stdout).toBe('');

        // §15.2: `--json` dumps the reply BEFORE the ok check, so failures are still machine-readable.
        const json = await kelpi.run(['web', 'exec', '--target', paneID, '--json', 'return nope'], {
            timeoutMs: 15_000
        });
        expect(json.code).toBe(1);
        expect(JSON.parse(json.stdout) as JsonRecord).toMatchObject({
            ok: false,
            error: 'ReferenceError: nope is not defined',
            js_error: { name: 'ReferenceError', line: 1 }
        });
    }, 60_000);

    // ── console ─────────────────────────────────────────────────────────────

    it('drains host console lines and empties the buffer with --clear', async () => {
        const paneID = await open('https://example.com');
        host.emit('console', paneID, { level: 'log', message: 'one', url: 'https://example.com/' });
        host.emit('console', paneID, { level: 'warn', message: 'two', url: 'https://example.com/' });

        const drained = await kelpi.run(['web', 'console', '--target', paneID, '--clear', '--json'], {
            timeoutMs: 15_000
        });
        expect(drained.code, drained.stderr).toBe(0);
        const reply = JSON.parse(drained.stdout) as {
            lines: { seq: number; level: string; message: string }[];
            next_since: number;
        };
        expect(reply.lines.map((line) => [line.seq, line.level, line.message])).toEqual([
            [0, 'log', 'one'],
            [1, 'warn', 'two']
        ]);
        expect(reply.next_since).toBe(2);

        // `--clear` drops what it returned: the next read starts empty, and the sequence keeps
        // counting (an agent's `--since` cursor stays valid across a clear).
        const after = await kelpi.run(['web', 'console', '--target', paneID, '--json'], {
            timeoutMs: 15_000
        });
        expect(JSON.parse(after.stdout)).toMatchObject({ ok: true, lines: [], next_since: 2 });

        host.emit('console', paneID, { level: 'error', message: 'three', url: 'https://example.com/' });
        const later = await kelpi.run(['web', 'console', '--target', paneID], { timeoutMs: 15_000 });
        expect(later.stdout).toContain('[2] error: three');
    }, 60_000);

    // ── closing ─────────────────────────────────────────────────────────────

    it('tells the host when the web pane is closed, and stops resolving it', async () => {
        const paneID = await open('https://example.com');
        await host.waitForNotify('pane-open');

        const closed = await kelpi.run(['pane', 'close', '--target', paneID], { timeoutMs: 15_000 });
        expect(closed.code, closed.stderr).toBe(0);

        const notify = await host.waitForNotify(
            'pane-close',
            (args) => String(args['paneID']).toUpperCase() === paneID.toUpperCase()
        );
        expect(notify.args['paneID']).toBe(paneID);

        const panes = await kelpi.json<PaneListEntryJSON[]>(['pane', 'list', '--json']);
        expect(panes.map((pane) => pane.id)).not.toContain(paneID);

        const orphan = await kelpi.run(['web', 'tabs', '--target', paneID, '--json'], {
            timeoutMs: 15_000
        });
        expect(orphan.code).toBe(1);
        expect(orphan.stderr).toContain(paneID);
    }, 60_000);

    // ── scope errors ────────────────────────────────────────────────────────

    it('refuses a label target with no workspace scope before touching the socket', async () => {
        const paneID = await open('https://example.com');
        const calls = host.calls.length;

        const bare = await kelpi.run(['web', 'capture', '--target', 'somelabel'], {
            timeoutMs: 15_000
        });
        expect(bare.code).toBe(1);
        expect(bare.stderr).toContain(
            '--target by label requires --workspace <name-or-id> when called outside a Nex pane'
        );

        const noTarget = await kelpi.run(['web', 'capture'], { timeoutMs: 15_000 });
        expect(noTarget.code).toBe(1);
        expect(noTarget.stderr).toContain('no --target supplied and NEX_PANE_ID is not set');

        expect(host.calls).toHaveLength(calls);
        // The pane is untouched by either refusal.
        expect(await tabs(paneID)).toHaveLength(1);
    }, 60_000);
});
