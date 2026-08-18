/**
 * `ping`, the health surface the CLI actually exposes it through (`nex doctor`), and the
 * honest failures for the command families that are stubbed until M6/M7.
 *
 * `nex doctor` is the only client-side consumer of `ping`: its third check does a full
 * round-trip through the same dispatch path a real command takes, so a green `ping` check
 * proves the control transport, the line framing, the reply allowlist and the reply-then-close
 * handshake all agree with the shipped binary.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startCompatDaemon, swiftCLIAvailable, type CompatDaemon } from './harness.js';

interface DoctorCheck {
    readonly name: string;
    readonly status: 'pass' | 'warn' | 'fail' | 'skip';
    readonly detail?: string;
    readonly repair?: string;
}

interface DoctorReport {
    readonly ok: boolean;
    readonly checks: readonly DoctorCheck[];
}

describe.skipIf(!swiftCLIAvailable())('compat: ping / doctor', () => {
    let nex: CompatDaemon;

    beforeEach(async () => {
        nex = await startCompatDaemon();
    }, 60_000);

    afterEach(async () => {
        await nex?.stop();
    });

    it('answers `nex doctor` with a passing ping round-trip', async () => {
        const result = await nex.run(['doctor', '--json']);
        // A WARN never fails doctor — only a FAILed check does (cli.md §6.6).
        expect(result.code).toBe(0);

        const report = JSON.parse(result.stdout) as DoctorReport;
        expect(report.ok).toBe(true);

        const byName = new Map(report.checks.map((check) => [check.name, check]));
        expect(byName.get('transport')?.status).toBe('pass');
        expect(byName.get('transport')?.detail).toContain(`127.0.0.1:${String(nex.port)}`);

        // The check that matters: a real request/response through the daemon's dispatcher.
        const ping = byName.get('ping');
        expect(ping?.status).toBe('pass');
        expect(ping?.detail).toContain('round-trip ok');
        // `ping` replies with the daemon's pid, which the CLI renders back at us.
        expect(ping?.detail).toContain(String(process.pid));

        // TCP transport ⇒ the CLI cannot inspect the "remote" process; that is a skip, not a
        // failure, and it must stay one or `nex doctor` starts lying over SSH tunnels.
        expect(byName.get('process')?.status).toBe('skip');

        // Version drift between the 0.32.0 Swift CLI and this daemon is expected during the
        // port and is documented as WARN-only (PLAN.md "Doctor/process-check drift").
        const version = byName.get('version');
        expect(version?.status).toBe('warn');
        expect(version?.detail).toContain(nex.info.version.version);
    }, 60_000);

    it('reports ping as failed once the daemon is gone', async () => {
        await nex.daemon.stop();
        const result = await nex.run(['doctor', '--json']);
        expect(result.code).toBe(1);
        const report = JSON.parse(result.stdout) as DoctorReport;
        expect(report.ok).toBe(false);
        const ping = report.checks.find((check) => check.name === 'ping');
        expect(ping?.status).toBe('fail');
    }, 60_000);
});

describe.skipIf(!swiftCLIAvailable())('compat: web panes (M6)', () => {
    let nex: CompatDaemon;

    beforeEach(async () => {
        nex = await startCompatDaemon();
    }, 60_000);

    afterEach(async () => {
        await nex?.stop();
    });

    // The daemon owns web-pane STATE, so opening a pane and reading its tabs works with no
    // Electron shell attached at all — which is the headless half of M6.
    it.each([
        ['web open', ['web', 'open', 'https://example.com']],
        // `nex open <url>` routes CLI-side to the same web-open verb.
        ['open <url>', ['open', 'https://example.com']]
    ])('%s creates a pane and prints its id', async (_label, args) => {
        const result = await nex.run(args, { timeoutMs: 15_000 });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('open ok:');
        expect(result.stdout).toContain('https://example.com');
    }, 60_000);

    it('lists the new pane as type web, with its tab', async () => {
        const opened = await nex.run(['web', 'open', 'https://example.com'], { timeoutMs: 15_000 });
        const paneID = /open ok: ([0-9A-Fa-f-]{36})/.exec(opened.stdout)?.[1];
        expect(paneID).toBeDefined();

        const panes = await nex.json<{ id: string; type: string }[]>(['pane', 'list', '--json']);
        expect(panes.find((pane) => pane.id === paneID)?.type).toBe('web');

        const tabs = await nex.json<{ url: string; active: boolean; index: number }[]>([
            'web',
            'tabs',
            '--target',
            paneID as string,
            '--json'
        ]);
        expect(tabs).toHaveLength(1);
        expect(tabs[0]).toMatchObject({ url: 'https://example.com', active: true, index: 0 });
    }, 60_000);

    // Anything that needs a real browser fails with a stable, greppable string instead of
    // hanging the CLI on a read timeout.
    it('fails browser-bound verbs with "no web pane host connected"', async () => {
        const opened = await nex.run(['web', 'open', 'https://example.com'], { timeoutMs: 15_000 });
        const paneID = /open ok: ([0-9A-Fa-f-]{36})/.exec(opened.stdout)?.[1] as string;

        for (const args of [
            ['web', 'click', '--target', paneID, 'css:#login'],
            ['web', 'text', '--target', paneID, 'css:body'],
            ['web', 'reload', '--target', paneID]
        ]) {
            const result = await nex.run(args, { timeoutMs: 15_000 });
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('no web pane host connected');
        }
    }, 60_000);

    it('reads an empty console buffer and refuses to close the only tab', async () => {
        const opened = await nex.run(['web', 'open', 'https://example.com'], { timeoutMs: 15_000 });
        const paneID = /open ok: ([0-9A-Fa-f-]{36})/.exec(opened.stdout)?.[1] as string;

        const console_ = await nex.run(['web', 'console', '--target', paneID, '--json'], {
            timeoutMs: 15_000
        });
        expect(console_.code).toBe(0);
        // `--json` prints the whole reply object (the CLI does not unwrap `lines` here).
        expect(JSON.parse(console_.stdout)).toMatchObject({
            ok: true,
            pane_id: paneID,
            lines: [],
            next_since: 0,
            dropped: 0,
            follow: false
        });

        const tabs = await nex.json<{ id: string }[]>([
            'web',
            'tabs',
            '--target',
            paneID,
            '--json'
        ]);
        const closing = await nex.run(
            ['web', 'tab-close', '--target', paneID, (tabs[0] as { id: string }).id],
            { timeoutMs: 15_000 }
        );
        expect(closing.code).toBe(1);
        expect(closing.stderr).toContain('cannot close the only tab in a web pane');
    }, 60_000);
});

describe.skipIf(!swiftCLIAvailable())('compat: graft (M7)', () => {
    let nex: CompatDaemon;

    beforeEach(async () => {
        nex = await startCompatDaemon();
    }, 60_000);

    afterEach(async () => {
        await nex?.stop();
    });

    it('renders an empty `graft status --json` as an empty array, exit 0', async () => {
        const result = await nex.run(['graft', 'status', '--json'], { timeoutMs: 15_000 });
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual([]);
    }, 60_000);

    it('reports the scope error verbatim when called with no scope at all', async () => {
        // No `--workspace`, no `--repo` and no NEX_PANE_ID: the daemon's error string is what
        // the shipped CLI prints, so it is contract.
        const result = await nex.run(['graft', 'start'], { timeoutMs: 15_000 });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('graft requires --workspace, --repo, or NEX_PANE_ID');
    }, 60_000);

    it('answers `graft stop --repo <unknown>` with "no active sessions"', async () => {
        // A repo filter that matches nothing is NOT an error (issue #231's orphan path).
        const result = await nex.run(['graft', 'stop', '--repo', '/nope'], { timeoutMs: 15_000 });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('No active sessions in scope.');
    }, 60_000);
});
