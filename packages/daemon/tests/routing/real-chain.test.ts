/**
 * The REAL agent-event chain, end to end — the regression net for the routing fix (7a7875d).
 *
 * Every audit and unit test before that commit validated agent flows by injecting events with
 * the daemon's socket explicitly set. These tests take the hops a Claude Code hook actually
 * takes: a real PTY shell inside a real pane runs a bare `kelpi …` resolved purely from the
 * pane's own environment — the `KELPID_HELPERS_DIR` PATH prepend finds the CLI, the injected
 * `KELPI_SOCKET=tcp:…` routes it to THIS daemon — and the daemon's store must move. Nothing
 * here sets `KELPI_SOCKET` on a command line, calls a dispatcher directly, or touches the
 * production `/tmp/nex.sock` (every daemon lives in a mkdtemp sandbox with its own compat
 * socket path and an ephemeral TCP port).
 *
 * The restart cases prove the resume contract the same way: the session id is bound by an
 * IN-PANE `kelpi event session-start`, the daemon is stopped and a second one booted on the
 * same state, and the respawned pane's own shell runs the typed `claude --resume <id>` —
 * asserted through a fake `claude` shim on the pane PATH that logs its argv. `session-end`
 * through the same in-pane chain must prevent the next restart's resume (issue #178 parity).
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDaemon, type Daemon } from '../../src/boot/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const cliBundle = path.join(repoRoot, 'packages', 'cli', 'dist', 'kelpi.js');

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
    while (cleanups.length > 0) {
        const cleanup = cleanups.pop();
        if (cleanup !== undefined) await cleanup();
    }
});

beforeAll(() => {
    // Normally present; a fresh clone's first `vitest run` self-heals rather than red-herrings.
    if (!fs.existsSync(cliBundle)) {
        execSync('pnpm --filter @kelpi/cli build', { cwd: repoRoot, stdio: 'ignore' });
    }
});

interface Sandbox {
    readonly root: string;
    readonly home: string;
    /** The pane-PATH dir: the real `kelpi` CLI + the fake `claude`, exactly what panes resolve. */
    readonly helpers: string;
    /** Where the fake `claude` logs one line of argv per invocation. */
    readonly claudeLog: string;
}

function sandbox(): Sandbox {
    const root = fs.mkdtempSync(path.join('/tmp', 'kelpid-routing-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    const helpers = path.join(root, 'helpers');
    fs.mkdirSync(helpers, { recursive: true });
    fs.writeFileSync(
        path.join(helpers, 'kelpi'),
        `#!/bin/sh\nexec "${process.execPath}" "${cliBundle}" "$@"\n`,
        { mode: 0o755 }
    );
    const claudeLog = path.join(root, 'claude-argv.log');
    fs.writeFileSync(path.join(helpers, 'claude'), `#!/bin/sh\necho "$@" >> "${claudeLog}"\n`, {
        mode: 0o755
    });
    return { root, home, helpers, claudeLog };
}

function daemonFor(box: Sandbox): Daemon {
    const daemon = createDaemon({
        env: { KELPID_HELPERS_DIR: box.helpers },
        home: box.home,
        runDir: path.join(box.root, 'run'),
        controlSocketPath: path.join(box.root, 'kelpi.sock'),
        dbPath: path.join(box.root, 'nex.db'),
        configPath: path.join(box.root, 'config'),
        httpPort: 0,
        settleMs: 50,
        bootDeferWindowMs: 0,
        spawn: { cols: 120, rows: 30, shell: '/bin/sh' }
    });
    cleanups.push(() => daemon.stop());
    return daemon;
}

function firstPane(daemon: Daemon): { id: string; status: string; agentSessionID: string | null } {
    const pane = daemon.store.getState().workspaces[0]?.panes[0];
    expect(pane).toBeDefined();
    const found = pane as NonNullable<typeof pane>;
    return { id: found.id, status: found.status, agentSessionID: found.agentSessionID };
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!check() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return check();
}

/** Give /bin/sh a beat to reach its prompt before typing at it. */
function settle(ms = 1_500): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const SESSION = 'dddddddd-0000-4000-8000-00000000abcd';

describe('real-chain event routing', () => {
    it('a bare in-pane `kelpi event` moves pane status: idle → running → waitingForInput', async () => {
        const box = sandbox();
        const daemon = daemonFor(box);
        await daemon.start();
        await daemon.restored;
        const pane = firstPane(daemon);
        expect(pane.status).toBe('idle');

        await settle();
        daemon.input.sendText(pane.id, 'kelpi event start', { bare: false });
        expect(await until(() => firstPane(daemon).status === 'running')).toBe(true);

        daemon.input.sendText(pane.id, 'kelpi event stop', { bare: false });
        expect(await until(() => firstPane(daemon).status === 'waitingForInput')).toBe(true);

        // Belt and braces: the pane's shell really carried the injected env (not just "some
        // event from somewhere arrived") — KELPI_PANE_ID names this pane, KELPI_SOCKET this daemon.
        daemon.input.sendText(pane.id, 'echo "route=$KELPI_SOCKET pane=$KELPI_PANE_ID"', { bare: false });
        await settle(500);
        const capture = await daemon.term.captureAsync(pane.id, { scrollback: true });
        expect(capture).toContain(`pane=${pane.id}`);
        expect(capture).toMatch(/route=tcp:127\.0\.0\.1:\d+/);
        expect(capture).toContain(`route=${String(daemon.ctx.controlTransport?.().paneRoute)}`);
    }, 40_000);

    it('in-pane session-start binds the session id; restart types `claude --resume` once; session-end prevents the next one', async () => {
        const box = sandbox();
        const first = daemonFor(box);
        await first.start();
        await first.restored;
        const pane = firstPane(first);

        await settle();
        first.input.sendText(
            pane.id,
            `printf '{"session_id":"${SESSION}"}' | kelpi event session-start`,
            { bare: false }
        );
        expect(await until(() => firstPane(first).agentSessionID === SESSION)).toBe(true);
        // The id must be persisted before the restart can resume from it.
        await first.stop();

        // Restart on the same state: the respawned pane's shell runs the typed resume via the
        // fake `claude` on its pane PATH.
        const second = daemonFor(box);
        await second.start();
        await second.restored;
        expect(
            await until(() => {
                try {
                    return fs.readFileSync(box.claudeLog, 'utf8').includes(`--resume ${SESSION}`);
                } catch {
                    return false;
                }
            }, 15_000)
        ).toBe(true);
        expect(
            fs
                .readFileSync(box.claudeLog, 'utf8')
                .split('\n')
                .filter((line) => line.includes('--resume')).length
        ).toBe(1);

        // The resumed session ends cleanly (SessionEnd hook, issue #178): the tracked id is
        // cleared, so the KELPIT restart must not resume it.
        await settle();
        const paneNow = firstPane(second);
        second.input.sendText(
            paneNow.id,
            `printf '{"session_id":"${SESSION}"}' | kelpi event session-end`,
            { bare: false }
        );
        expect(await until(() => firstPane(second).agentSessionID === null)).toBe(true);
        await second.stop();

        const third = daemonFor(box);
        await third.start();
        await third.restored;
        await settle(2_500);
        expect(
            fs
                .readFileSync(box.claudeLog, 'utf8')
                .split('\n')
                .filter((line) => line.includes('--resume')).length
        ).toBe(1);
        expect(firstPane(third).agentSessionID).toBeNull();
    }, 90_000);
});
