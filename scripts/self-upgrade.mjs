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
 *   node scripts/self-upgrade.mjs --detach       # THE way to promote from inside a pane
 *   node scripts/self-upgrade.mjs                # package the tree, verify, promote
 *   node scripts/self-upgrade.mjs --no-package   # promote the already-packaged bundle
 *   node scripts/self-upgrade.mjs --dry-run      # show the plan, touch nothing
 *
 * EVIDENCE RULE (learned 2026-08-31, cost two lost promotes): a promote started from inside
 * a Kelpi pane is a child of the pane it will destroy — when the session hosting it is cut
 * mid-battery, the process, its output, and even the conversation that launched it all die
 * unrecorded. So nothing about a promote may live only in the pane. `--detach` re-execs this
 * script nohup'd, all output goes to a log under the daemon's state dir, every phase
 * transition lands in `~/Library/Application Support/kelpid/last-promote.json`, and the
 * restarter writes the final "promoted"/"restart-failed" verdict there too. After ANY
 * promote, read that file first.
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
    value('--app') ?? path.join(repoRoot, 'packages', 'shell', 'out', 'Kelpi-darwin-arm64', 'Kelpi.app');
const runDir =
    value('--run-dir') ?? path.join(os.homedir(), 'Library', 'Application Support', 'kelpid', 'run');
const dryRun = has('--dry-run');
const noPackage = has('--no-package');
const relaunchCmd = value('--relaunch-cmd') ?? `open "${appPath}"`;
// PATH-ANCHORED by default: a generic "kelpid.js start" would also match sandbox daemons and —
// in test invocations — the real one. The pattern must name the bundle whose daemon we own.
const daemonPattern =
    value('--daemon-pattern') ??
    (appPath.endsWith('.app') ? `${appPath}/Contents/Resources/daemon/kelpid.js` : 'kelpid.js start');

const log = (line) => console.log(`[self-upgrade] ${line}`);

// ── promote evidence (must outlive the pane this script kills) ──────────────────────

const stateDir = path.join(os.homedir(), 'Library', 'Application Support', 'kelpid');
const statusFile = path.join(stateDir, 'last-promote.json');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const promoteLog = process.env.KELPI_PROMOTE_LOG;
const writeStatus = (phase, extra = {}) => {
    if (dryRun) return;
    try {
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(
            statusFile,
            `${JSON.stringify(
                {
                    phase,
                    pid: process.pid,
                    log: promoteLog ?? null,
                    updatedAt: new Date().toISOString(),
                    ...extra
                },
                null,
                2
            )}\n`
        );
    } catch {
        // Status is best-effort — it must never break the promote itself.
    }
};

if (has('--detach')) {
    fs.mkdirSync(stateDir, { recursive: true });
    const detachedLog = path.join(stateDir, `promote-${stamp}.log`);
    const out = fs.openSync(detachedLog, 'a');
    // A promote is usually launched from INSIDE a Claude Code session, and macOS `open`
    // propagates the caller's env — so without this scrub the relaunched app, its daemon and
    // every restored pane inherit the promoting session's markers (CLAUDE_CODE_CHILD_SESSION,
    // a stale CLAUDE_CODE_SESSION_ID, its messaging socket, its CLAUDE_CONFIG_DIR), and the
    // post-promote `claude --resume` loses the very conversation it is resuming (measured,
    // 2026-09-01; the daemon's pane spawn filters the same class as a second layer).
    const cleanEnv = Object.fromEntries(
        Object.entries(process.env).filter(
            ([key]) => !(key.startsWith('CLAUDE_') || key === 'CLAUDECODE' || key === 'AI_AGENT')
        )
    );
    const worker = spawn(
        'nohup',
        [process.execPath, fileURLToPath(import.meta.url), ...args.filter((flag) => flag !== '--detach')],
        {
            cwd: repoRoot,
            detached: true,
            stdio: ['ignore', out, out],
            env: { ...cleanEnv, KELPI_PROMOTE_LOG: detachedLog }
        }
    );
    worker.unref();
    log(`detached promote pid ${worker.pid} — this survives the pane, the app, and the daemon.`);
    log(`log:    ${detachedLog}`);
    log(`status: ${statusFile}`);
    log(`follow: tail -f "${detachedLog}"`);
    process.exit(0);
}

// ── 0. the battery ──────────────────────────────────────────────────────────────────
// A promote is the moment the owner receives the build, so it is the moment the FULL
// battery runs — the tiered flow's whole bargain (scoped checks per change) rests on this
// gate being unskippable in the normal path. --skip-verify exists for a re-promote of a
// bundle the battery already passed, and it says so out loud.

if (!has('--skip-verify') && !dryRun) {
    log('running the full battery first (scripts/verify.mjs --full; skip with --skip-verify');
    log('only when re-promoting a bundle the battery already passed)…');
    writeStatus('battery-running');
    try {
        execSync(`"${process.execPath}" scripts/verify.mjs --full`, { cwd: repoRoot, stdio: 'inherit' });
    } catch (error) {
        writeStatus('failed', { failedDuring: 'battery', error: String(error?.message ?? error) });
        console.error('[self-upgrade] the battery FAILED — nothing was promoted; the log has the failing check.');
        process.exit(1);
    }
    writeStatus('battery-passed');
} else if (has('--skip-verify')) {
    log('SKIPPING the battery (--skip-verify) — this bundle had better have passed it already.');
}

// ── 1. package ──────────────────────────────────────────────────────────────────────

if (!noPackage && !dryRun) {
    log('building + packaging the tree (skip with --no-package)…');
    writeStatus('packaging');
    try {
        execSync('pnpm --filter @kelpi/daemon build && pnpm --filter @kelpi/client build && pnpm --filter @kelpi/cli build && pnpm --filter @kelpi/shell build', {
            cwd: repoRoot,
            stdio: 'inherit'
        });
        execSync('pnpm run package', { cwd: path.join(repoRoot, 'packages', 'shell'), stdio: 'inherit' });
    } catch (error) {
        writeStatus('failed', { failedDuring: 'packaging', error: String(error?.message ?? error) });
        console.error('[self-upgrade] packaging FAILED — nothing was promoted.');
        process.exit(1);
    }
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

// ps, not pgrep: macOS pgrep -f silently fails to match long argv strings (measured — the
// running daemon's ~200-char command line matches `ps | grep` and not `pgrep -f`, even with a
// short pattern). A matcher that can silently return nothing is exactly what this script
// cannot be built on — which is also why a ps FAILURE aborts the promote instead of reading
// as "nothing is running": the process table on a busy machine exceeds Node's default 1MB
// maxBuffer (Chromium helpers carry multi-KB argvs), and the ENOBUFS that throws turned one
// full promote into a no-op relaunch beside the still-live pair (measured, 2026-08-30).
const psTable = (() => {
    try {
        return execFileSync('ps', ['-axo', 'pid=,command='], {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024
        });
    } catch (error) {
        console.error(`[self-upgrade] ps failed — refusing to promote blind: ${String(error?.message ?? error)}`);
        process.exit(1);
    }
})();
const psMatch = (pattern, alsoRequire) =>
    psTable
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.includes(pattern) && (alsoRequire === undefined || line.includes(alsoRequire)))
        .map((line) => Number(line.split(/\s+/)[0]))
        .filter((pid) => Number.isFinite(pid) && pid !== process.pid);
// Pre-rename bundles this repo may still be running: a promote has to stop the app/daemon it
// is replacing even when that pair was launched under an old name — the Nex-branded bundle
// (product rename), or this checkout's previous directory (`new_nex`, before it moved to
// `kelpi`), whose path lives on in the running processes' argv after the directory itself is
// renamed. ONLY this checkout's own out/ bundles — /Applications/Nex.app may be the Swift
// original, which this script must never touch (same anchoring rule as `daemonPattern`).
const previousCheckout = path.join(path.dirname(repoRoot), 'new_nex', 'packages', 'shell', 'out');
const legacyAppPaths = [
    path.join(repoRoot, 'packages', 'shell', 'out', 'Nex-darwin-arm64', 'Nex.app'),
    path.join(previousCheckout, 'Kelpi-darwin-arm64', 'Kelpi.app'),
    path.join(previousCheckout, 'Nex-darwin-arm64', 'Nex.app')
].filter((candidate) => candidate !== appPath);

const appPids = appPath.endsWith('.app')
    ? [
          ...psMatch(`${appPath}/Contents/MacOS/`),
          ...legacyAppPaths.flatMap((legacy) => psMatch(`${legacy}/Contents/MacOS/`))
      ]
    : [];
// `start --foreground` filters out transient CLI invocations running through the same bundle.
// The legacy match is directory-anchored (not entry-file-anchored) so it sees both daemon
// entry names, `nexd.js` and `kelpid.js`.
const daemonPids = [
    ...psMatch(daemonPattern, 'start --foreground'),
    ...legacyAppPaths.flatMap((legacy) =>
        psMatch(`${legacy}/Contents/Resources/daemon/`, 'start --foreground')
    )
];

log(`running app pids: ${appPids.join(', ') || '(none)'}`);
log(`running daemon pids: ${daemonPids.join(', ') || '(none)'}`);
const insideKelpi = process.env.KELPI_PANE_ID !== undefined || process.env.NEX_PANE_ID !== undefined;
if (insideKelpi) {
    log(`invoked from INSIDE a Kelpi pane (${process.env.KELPI_PANE_ID ?? process.env.NEX_PANE_ID}) — this session will be`);
    log('cut and then RESUMED by the restored pane (claude --resume). That is the expected dance.');
}

if (dryRun) {
    log('dry run: would detach a restarter that terminates the pids above, then runs:');
    log(`  ${relaunchCmd}`);
    process.exit(0);
}

// ── 4. the detached restarter ───────────────────────────────────────────────────────
// Script and log live in the state dir, not the pane and not a temp dir a cleaner may
// sweep — they ARE the record of what the restarter did once nothing else survives.

const logFile = path.join(stateDir, `restarter-${stamp}.log`);
const script = path.join(stateDir, `restarter-${stamp}.sh`);
fs.mkdirSync(stateDir, { recursive: true });

const waitGone = (pid) => `
i=0; while kill -0 ${pid} 2>/dev/null && [ $i -lt 30 ]; do sleep 0.5; i=$((i+1)); done
kill -0 ${pid} 2>/dev/null && kill -9 ${pid} 2>/dev/null`;

fs.writeFileSync(
    script,
    `#!/bin/sh
# kelpi self-upgrade restarter (${stamp}) — detached so it survives the daemon it kills.
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
    printf '{\\n  "phase": "promoted",\\n  "port": %s,\\n  "updatedAt": "%s",\\n  "log": ${JSON.stringify(promoteLog ?? logFile)},\\n  "restarterLog": ${JSON.stringify(logFile)}\\n}\\n' "$PORT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${JSON.stringify(statusFile)}
    exit 0
  fi
  sleep 1; i=$((i+1))
done
echo "restarter: TIMED OUT waiting for health — check manually"
printf '{\\n  "phase": "restart-failed",\\n  "updatedAt": "%s",\\n  "log": ${JSON.stringify(promoteLog ?? logFile)},\\n  "restarterLog": ${JSON.stringify(logFile)}\\n}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${JSON.stringify(statusFile)}
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
writeStatus('restarter-detached', { restarter: script, restarterLog: logFile, appPids, daemonPids });
log('upgrade initiated. If this session lives in a pane, see you on the other side.');
process.exit(0);
