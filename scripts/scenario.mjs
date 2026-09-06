#!/usr/bin/env node
/**
 * Run UI scenarios against a real Kelpi: boot a private sandbox, or attach to a dev instance
 * that is already up, drive it through `scripts/ui-audit/lib/driver.mjs`, and report.
 *
 *   node scripts/scenario.mjs                                  # every scenario in scripts/scenarios/
 *   node scripts/scenario.mjs confirm-dialog-keys              # one, by name
 *   node scripts/scenario.mjs scripts/scenarios/foo.mjs --no-build
 *   node scripts/scenario.mjs --attach 57384 --harness ~/tmp/kelpi-x/harness.sock <name>
 *   node scripts/scenario.mjs --keep <name>                    # leave the sandbox up afterwards
 *
 * A scenario is an ES module whose default export is `async (t) => {}` receiving:
 *   t.page      the CDP page (lib/cdp.mjs): eval, waitFor, click, key, type, box, screenshot
 *   t.harness   the shell channel: menu, menuClick, press, counters, armDialog, window, focus, blur
 *   t.cli       the sandbox's kelpi CLI (boot only): run(args, {env}), ok(args) -> stdout
 *   t.sandbox   paths and ports (boot only): configPath, root, base, controlPort, debugPort
 *   t.rec       the recorder: check(label, ok, detail), note(msg), shot(page, label)
 *   t.d         the driver module itself (PAGE, clickMenuItem, openSidebarMenu, settleDom, ...)
 *   t.sleep
 * It passes when every `rec.check` is true and it throws nothing. Exit code 1 otherwise.
 *
 * WHY A SEPARATE RUNNER from the audit: the audit is a fixed regression battery that measures
 * the app; a scenario is written for one change, by the person or agent making it, and run
 * against the tree that carries it. verify.mjs will learn to require one when a UI surface
 * changes; until then the rule is social. See scripts/ui-audit/README.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const driver = await import(path.join(repoRoot, 'scripts', 'ui-audit', 'lib', 'driver.mjs'));

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
};
const flagsWithValues = new Set(['--attach', '--harness', '--out']);
const positional = args.filter((a, i) => !a.startsWith('--') && !flagsWithValues.has(args[i - 1] ?? ''));

const scenariosDir = path.join(repoRoot, 'scripts', 'scenarios');
const resolveScenario = (name) => {
    if (name.endsWith('.mjs') && fs.existsSync(name)) return path.resolve(name);
    const candidate = path.join(scenariosDir, `${name.replace(/\.mjs$/, '')}.mjs`);
    if (fs.existsSync(candidate)) return candidate;
    throw new Error(`no such scenario: ${name} (looked in ${scenariosDir})`);
};
const files =
    positional.length > 0
        ? positional.map(resolveScenario)
        : fs.readdirSync(scenariosDir).filter((f) => f.endsWith('.mjs')).sort().map((f) => path.join(scenariosDir, f));
if (files.length === 0) {
    console.error('no scenarios found');
    process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = value('--out') ?? path.join(repoRoot, 'docs', 'audit', 'scenarios', stamp);
fs.mkdirSync(outDir, { recursive: true });
const log = (line) => console.log(`[scenario] ${line}`);

// ── the instance ────────────────────────────────────────────────────────────────────

let t;
const attachPort = value('--attach');
if (attachPort !== undefined) {
    log(`attaching to debug port ${attachPort}${value('--harness') ? ` and harness ${value('--harness')}` : ''}`);
    t = await driver.attach({
        debugPort: Number(attachPort),
        ...(value('--harness') === undefined ? {} : { harnessSocket: value('--harness').replace(/^~(?=\/|$)/, process.env.HOME ?? '') }),
        repoRoot
    });
} else {
    log(`booting a sandbox${has('--no-build') ? ' (no build)' : ' (building first; skip with --no-build)'}`);
    t = await driver.boot({ repoRoot, label: 'scenario', build: !has('--no-build'), log });
    log(`up: ${t.sandbox.base}  debug ${String(t.debugPort)}  harness ${t.harness.path}`);
}

const stop = async () => {
    if (has('--keep') && attachPort === undefined) {
        log(`--keep: leaving the sandbox up (debug ${String(t.debugPort)}, harness ${t.harness?.path ?? 'none'}); Ctrl-C to end`);
        await new Promise(() => {});
    }
    await t.stop();
};
process.on('SIGINT', () => {
    void t.stop().finally(() => process.exit(130));
});

// ── the run ─────────────────────────────────────────────────────────────────────────

const summaries = [];
let anyFailed = false;
for (const file of files) {
    const name = path.basename(file, '.mjs');
    log(`▶ ${name}`);
    const rec = driver.recorder({ name, outDir });
    const started = Date.now();
    try {
        const mod = await import(pathToFileURL(file).href);
        if (typeof mod.default !== 'function') throw new Error(`${file} has no default export function`);
        await mod.default({ page: t.page, harness: t.harness, cli: t.cli, sandbox: t.sandbox, rec, d: driver, sleep: driver.sleep, repoRoot });
    } catch (error) {
        rec.check('the scenario ran to completion', false, error instanceof Error ? error.stack ?? error.message : String(error));
        try {
            await rec.shot(t.page, 'on-error');
        } catch {
            /* the page may be gone */
        }
    }
    const summary = { ...rec.summary(), ms: Date.now() - started };
    summaries.push(summary);
    if (summary.failed > 0) anyFailed = true;
    log(`${summary.failed === 0 ? '✓' : '✗'} ${name}: ${String(summary.checks - summary.failed)}/${String(summary.checks)} checks in ${String(Math.round(summary.ms / 100) / 10)}s`);
}

fs.writeFileSync(path.join(outDir, 'results.json'), `${JSON.stringify({ stamp, files, summaries }, null, 2)}\n`);
log(`results: ${path.join(outDir, 'results.json')}`);
await stop();
process.exit(anyFailed ? 1 : 0);
