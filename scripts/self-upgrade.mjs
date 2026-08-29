#!/usr/bin/env node
/**
 * Promote a freshly packaged build under the RUNNING instance — including the instance
 * hosting the session that invokes this.
 *
 * The self-hosting problem: a pane's PTY is a child of the daemon, so the process that runs
 * this script dies partway through the upgrade it started. The dance is therefore DETACHED:
 * this script verifies everything, writes a small restarter to disk, launches it with nohup
 * parented away from the doomed process tree, prints its goodbye, and exits. The restarter
 * then: SIGTERMs the app (waits), SIGTERMs the daemon (waits — a clean daemon shutdown
 * persists every pane and session id), relaunches the .app, and polls the daemon's health.
 * The restored panes come back through the boot-restore pipeline, and any pane with a tracked
 * agent session gets its `claude --resume <id>` typed — the machinery §N13's wave proved with
 * argv-logging shims and the N19/N15 waves proved for caret and window focus.
 *
 *   node scripts/self-upgrade.mjs                # package the tree, verify, promote
 *   node scripts/self-upgrade.mjs --no-package   # promote the already-packaged bundle
 *   node scripts/self-upgrade.mjs --dry-run      # show the plan, touch nothing
 *
 * Test-mode flags (used by the sandbox proof; not for real use):
 *   --app <path> --run-dir <dir> --relaunch-cmd <shell line> --daemon-pattern <pgrep pattern>
 */

import { execFileSync, execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
};

const appPath =
    value('--app') ?? path.join(repoRoot, 'packages', 'shell', 'out', 'Nex-darwin-arm64', 'Nex.app');
const runDir =
    value('--run-dir') ?? path.join(os.homedir(), 'Library', 'Application Support', 'nexd', 'run');
const dryRun = has('--dry-run');
const noPackage = has('--no-package');
const relaunchCmd = value('--relaunch-cmd') ?? `open "${appPath}"`;
// PATH-ANCHORED by default: a generic "nexd.js start" would also match sandbox daemons and —
// in test invocations — the real one. The pattern must name the bundle whose daemon we own.
const daemonPattern =
    value('--daemon-pattern') ??
    (appPath.endsWith('.app') ? `${appPath}/Contents/Resources/daemon/nexd.js` : 'nexd.js start');

const log = (line) => console.log(`[self-upgrade] ${line}`);

// ── 1. package ──────────────────────────────────────────────────────────────────────

if (!noPackage && !dryRun) {
    log('building + packaging the tree (skip with --no-package)…');
    execSync('pnpm --filter @nex/daemon build && pnpm --filter @nex/client build && pnpm --filter @nex/cli build && pnpm --filter @nex/shell build', {
        cwd: repoRoot,
        stdio: 'inherit'
    });
    execSync('pnpm run package', { cwd: path.join(repoRoot, 'packages', 'shell'), stdio: 'inherit' });
}

// ── 2. verify the bundle ────────────────────────────────────────────────────────────

if (!fs.existsSync(appPath)) {
    console.error(`[self-upgrade] no bundle at ${appPath}`);
    process.exit(1);
}
if (appPath.endsWith('.app')) {
    try {
        execFileSync('codesign', ['--verify', '--strict', appPath], { stdio: 'pipe' });
        log('bundle signature: valid');
    } catch (error) {
        console.error('[self-upgrade] the packaged bundle FAILS codesign --verify --strict — refusing to promote it.');
        console.error(String(error.stderr ?? error.message));
        process.exit(1);
    }
}

// ── 3. find the running pair ────────────────────────────────────────────────────────

const pgrep = (pattern) => {
    try {
        return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(Number)
            .filter((pid) => pid !== process.pid);
    } catch {
        return [];
    }
};
const appPids = appPath.endsWith('.app') ? pgrep(`${appPath}/Contents/MacOS/`) : [];
const daemonPids = pgrep(daemonPattern);

log(`running app pids: ${appPids.join(', ') || '(none)'}`);
log(`running daemon pids: ${daemonPids.join(', ') || '(none)'}`);
const insideNex = process.env.NEX_PANE_ID !== undefined;
if (insideNex) {
    log(`invoked from INSIDE a Nex pane (${process.env.NEX_PANE_ID}) — this session will be`);
    log('cut and then RESUMED by the restored pane (claude --resume). That is the expected dance.');
}

if (dryRun) {
    log('dry run: would detach a restarter that terminates the pids above, then runs:');
    log(`  ${relaunchCmd}`);
    process.exit(0);
}

// ── 4. the detached restarter ───────────────────────────────────────────────────────

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logFile = path.join(os.tmpdir(), `nex-self-upgrade-${stamp}.log`);
const script = path.join(os.tmpdir(), `nex-self-upgrade-${stamp}.sh`);

const waitGone = (pid) => `
i=0; while kill -0 ${pid} 2>/dev/null && [ $i -lt 30 ]; do sleep 0.5; i=$((i+1)); done
kill -0 ${pid} 2>/dev/null && kill -9 ${pid} 2>/dev/null`;

fs.writeFileSync(
    script,
    `#!/bin/sh
# nex self-upgrade restarter (${stamp}) — detached so it survives the daemon it kills.
exec > "${logFile}" 2>&1
echo "restarter: starting ($(date))"
sleep 1
${appPids.map((pid) => `echo "restarter: stopping app ${pid}"; kill -TERM ${pid} 2>/dev/null${waitGone(pid)}`).join('\n')}
${daemonPids.map((pid) => `echo "restarter: stopping daemon ${pid}"; kill -TERM ${pid} 2>/dev/null${waitGone(pid)}`).join('\n')}
echo "restarter: relaunching"
${relaunchCmd}
echo "restarter: waiting for the daemon"
i=0
while [ $i -lt 60 ]; do
  PORT=$(cat "${runDir}/daemon-v1.port" 2>/dev/null)
  if [ -n "$PORT" ] && curl -s -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo "restarter: daemon healthy on port $PORT ($(date))"
    exit 0
  fi
  sleep 1; i=$((i+1))
done
echo "restarter: TIMED OUT waiting for health — check manually"
exit 1
`,
    { mode: 0o755 }
);

log(`restarter: ${script}`);
log(`restarter log: ${logFile}`);
const child = spawn('nohup', [script], {
    detached: true,
    stdio: 'ignore'
});
child.unref();
log('upgrade initiated. If this session lives in a pane, see you on the other side.');
process.exit(0);
