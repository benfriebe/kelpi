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

describe.skipIf(!swiftCLIAvailable())('compat: deliberately stubbed families', () => {
    let nex: CompatDaemon;

    beforeEach(async () => {
        nex = await startCompatDaemon();
    }, 60_000);

    afterEach(async () => {
        await nex?.stop();
    });

    // PLAN.md WP2.5: graft-* and web-* answer honestly instead of hanging the caller. The
    // CLI must see a structured `ok:false` (exit 1 + one stderr line), never a read timeout.
    it.each([
        ['graft status', ['graft', 'status', '--json']],
        ['graft start', ['graft', 'start']],
        ['web open', ['web', 'open', 'https://example.com']],
        // `nex open <url>` routes CLI-side to the same web-open verb.
        ['open <url>', ['open', 'https://example.com']]
    ])('%s fails fast with "not supported yet"', async (_label, args) => {
        const result = await nex.run(args, { timeoutMs: 15_000 });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('not supported yet');
        expect(result.stdout).toBe('');
    }, 60_000);
});
