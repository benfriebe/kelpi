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
 *   node scripts/scenario.mjs --window hidden <name>           # without taking the screen (#65)
 *
 * `--window hidden | offscreen | onscreen` opens the harness functional lane. Unset, nothing about
 * the run changes: the shell builds the window it always built. `hidden` gives the machine's owner
 * their screen back and lets several runs overlap (two, three, four at once, each in its own
 * sandbox) at the cost of the screenshots, which come back blank; `rec.shot` says so in the note
 * it writes. Assertions are unaffected: the DOM, CDP input, the harness channel, the CLI and the
 * app's own activity signalling all behave the same. Never use it for a check that measures pixels.
 * See ui-audit/README.md for the measurements and for what `onscreen`/`offscreen` cost.
 *
 * A scenario is an ES module whose default export is `async (t) => {}` receiving:
 *   t.page      the CDP page (lib/cdp.mjs): eval, waitFor, click, key, type, box, screenshot
 *   t.harness   the shell channel: menu, menuClick, press, counters, armDialog, window, focus, blur
 *   t.cli       the sandbox's kelpi CLI (boot only): run(args, {env}), ok(args) -> stdout
 *   t.sandbox   paths and ports (boot only): configPath, root, base, controlPort, debugPort
 *   t.shell     the shell process (boot only, else null): lines[], text(), waitForLine(re, label)
 *   t.rec       the recorder: check(label, ok, detail), note(msg), shot(page, label)
 *   t.d         the driver module itself (PAGE, clickMenuItem, openSidebarMenu, settleDom, ...)
 *   t.sleep
 * It passes when every `rec.check` is true and it throws nothing. Exit code 1 otherwise.
 *
 * A scenario may also declare what source it drives, which is how `verify.mjs` decides to re-run
 * it for a change that never touched this directory:
 *   export const covers = ['packages/client/src/chrome/Sidebar.tsx', 'packages/shell/src/menu.ts'];
 *
 * WHY A SEPARATE RUNNER from the audit: the audit is a fixed regression battery that measures
 * the app; a scenario is written for one change, by the person or agent making it, and run
 * against the tree that carries it. `verify.mjs` now REQUIRES one when a UI surface changes and
 * runs what it selected (`--no-build --window hidden` in both tiers); the rule is no longer
 * social. See scripts/ui-audit/README.md ▸ The rule.
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
const flagsWithValues = new Set(['--attach', '--harness', '--out', '--window']);
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

// Unset is the shipped window: the lane never opens and a run is exactly what it was before it
// existed. See driver.mjs ▸ WINDOW_PLACEMENTS for why `onscreen` is not the default.
const placement = value('--window');
if (placement !== undefined && !driver.WINDOW_PLACEMENTS.includes(placement)) {
    console.error(`--window ${placement}: want ${driver.WINDOW_PLACEMENTS.join(' | ')}`);
    process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
let outDir = value('--out') ?? path.join(repoRoot, 'docs', 'audit', 'scenarios', stamp);
// Runs in parallel are the point of the hidden lane, and two started inside the same millisecond
// share a stamp: without this they would write their screenshots and their results.json into one
// directory and the second would win. The pid is appended only when it is actually needed, so a
// serial run's path shape is unchanged.
if (value('--out') === undefined && fs.existsSync(outDir)) outDir = `${outDir}-${String(process.pid)}`;
fs.mkdirSync(outDir, { recursive: true });
const log = (line) => console.log(`[scenario] ${line}`);

// ── the instance ────────────────────────────────────────────────────────────────────

let t;
const attachPort = value('--attach');
if (attachPort !== undefined) {
    // --window is a property of a shell this runner LAUNCHES. An instance that is already up was
    // placed by whoever started it, so saying nothing is the only honest thing to do here: the
    // recorder gets no placement and writes its screenshot notes without a caveat it cannot back.
    if (value('--window') !== undefined) log('--window is ignored with --attach: the instance is already placed');
    log(`attaching to debug port ${attachPort}${value('--harness') ? ` and harness ${value('--harness')}` : ''}`);
    t = await driver.attach({
        debugPort: Number(attachPort),
        ...(value('--harness') === undefined ? {} : { harnessSocket: value('--harness').replace(/^~(?=\/|$)/, process.env.HOME ?? '') }),
        repoRoot
    });
} else {
    log(`booting a sandbox${has('--no-build') ? ' (no build)' : ' (building first; skip with --no-build)'}`);
    t = await driver.boot({ repoRoot, label: 'scenario', build: !has('--no-build'), log, window: placement });
    log(
        `up: ${t.sandbox.base}  debug ${String(t.debugPort)}  harness ${t.harness.path}  ` +
            `window ${t.windowPlacement}${
                t.windowPlacement === 'hidden' || t.windowPlacement === 'offscreen'
                    ? ' (functional lane: the screenshots are not trustworthy)'
                    : ''
            }`
    );
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
    const rec = driver.recorder({ name, outDir, placement: t.windowPlacement });
    const started = Date.now();
    try {
        const mod = await import(pathToFileURL(file).href);
        if (typeof mod.default !== 'function') throw new Error(`${file} has no default export function`);
        await mod.default({
            page: t.page,
            harness: t.harness,
            cli: t.cli,
            sandbox: t.sandbox,
            // The shell's own stdout, for behaviour whose only external evidence is a log line
            // (the web-pane placement trail, `web pane <id> view owner=main|holder`). Null under
            // `--attach`, where this runner did not launch the shell and cannot read its pipe; a
            // scenario that needs it must say so rather than assume.
            shell: t.shell ?? null,
            rec,
            d: driver,
            sleep: driver.sleep,
            repoRoot
        });
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

// The placement goes in the file, not just the terminal: a results.json read a week later must
// say whether its blank screenshots are a bug or the lane.
fs.writeFileSync(
    path.join(outDir, 'results.json'),
    `${JSON.stringify({ stamp, windowPlacement: t.windowPlacement ?? 'attached', files, summaries }, null, 2)}\n`
);
log(`results: ${path.join(outDir, 'results.json')}`);
await stop();
process.exit(anyFailed ? 1 : 0);
