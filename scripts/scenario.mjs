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
 * And it may declare the WEAKEST window placement it can be trusted at, which a run below that
 * floor honours by giving it an instance of its own at the declared placement:
 *   export const windowPlacement = 'offscreen';
 * A floor, never a ceiling: a stronger run is never dragged down, and a run that opened no lane is
 * left exactly alone. `ui-audit/lib/placement.mjs` has the rule, the reason (#206: a zero-opacity
 * frame with another window in front of it is occluded, and Chromium then drops the input CDP
 * delivers to its native `WebContentsView`s) and the measurement. The placement each scenario ran
 * at is printed beside its name and written into `results.json`.
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
const { resolveScenarioPlacement } = await import(path.join(repoRoot, 'scripts', 'ui-audit', 'lib', 'placement.mjs'));

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

// ── the post-condition: what a scenario must hand on unchanged ──────────────────────

/**
 * WHY THIS EXISTS (#205). A multi-scenario run shares ONE sandbox, one daemon and one window, so
 * everything a scenario leaves behind is the next scenario's starting state. Three deterministic
 * lane failures were filed as flakes before anyone looked: `plugin-document-features` opened the
 * phone on a host `plugin-browser-features` had shut down, `workspace-switch-keeps-the-caret`
 * waited for an engine count that leftover web panes could never reach, and
 * `plugin-terminal-features`'s ⌘C and ⌘V went nowhere because an earlier scenario left the page
 * believing it was not focused. Each passed alone, every time, so the battery's isolated retry
 * laundered all three into "load-sensitive".
 *
 * So the runner reads a short invariant set after every scenario and NAMES the scenario that
 * broke it. It is deliberately not a failure: a warning that costs nothing is a warning that
 * survives, and a runner that failed a green scenario on its housekeeping would be turned off
 * within a week. It fires only in a multi-scenario run, which is the only place the state is
 * shared, and only what the scenario itself changed is reported (the diff is against the
 * PREVIOUS scenario's reading as well as the run's first one), so a leak is attributed once, to
 * the scenario that made it, rather than to everything that runs after it.
 */
const PAGE_STATE = `(() => {
    const selectors = ['[data-testid="plugin-ui-dialog"]', '[data-testid="command-palette"]', '[data-testid="confirm-dialog"]',
        '[data-testid="quit-dialog"]', '[data-testid="graft-swap-dialog"]', '[data-testid="modal"]'];
    // A plugin view left in a workbench slot, read from the window's own stores rather than from
    // Settings: every bundled view's id begins with "kelpi." (features/definitions.ts), so
    // anything else in a slot is a plugin's, and a plugin about to be removed leaves a slot naming
    // a view that no longer exists. Keyed by STORE as well as slot, because the key is
    // kelpi.workbench.v1:<daemonID> and a window that has looked at a remote host holds one per
    // daemon: "the terminal slot" is not one fact, and a leak has to say whose store it is in.
    const workbench = {};
    for (const key of Object.keys(localStorage)) {
        if (!key.startsWith('kelpi.workbench.v1:')) continue;
        const daemon = key.slice('kelpi.workbench.v1:'.length);
        try {
            const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
            for (const [slot, view] of Object.entries(saved ?? {})) {
                if (typeof view === 'string' && view.length > 0 && !view.startsWith('kelpi.')) workbench[slot + ' @ ' + daemon] = view;
            }
        } catch { /* an unreadable store is not this run's business */ }
    }
    const phoneShell = document.querySelector('[data-testid="phone-shell"]');
    return JSON.stringify({
        // phone/place.ts: a remembered {host, workspaceID} means the next phone window opens
        // THERE instead of on the landing page every phone scenario starts from.
        phonePlace: localStorage.getItem('kelpi.phone.last-place'),
        phoneLanding: phoneShell === null ? null : document.querySelector('[data-testid="phone-landing"]') !== null,
        workbench,
        settingsOpen: document.querySelector('[data-testid="settings-close"]') !== null,
        overlays: selectors.filter((selector) => document.querySelector(selector) !== null),
        // The lane window is never the key window, so the page believes it is focused only
        // because CDP emulation says so (driver.mjs ▸ setPageFocusEmulation). A scenario that
        // blurs and forgets to focus again takes every later chord with it.
        hasFocus: document.hasFocus(),
        viewport: \`\${String(window.innerWidth)}x\${String(window.innerHeight)}\`,
        url: location.href
    });
})()`;

/** The sandbox and the window as they stand right now, or `null` when nothing can be read. */
async function readWorld() {
    const world = { page: null, workspaces: null, activeWorkspace: null, webPanes: null };
    try {
        world.page = JSON.parse(String(await t.page.eval(PAGE_STATE)));
    } catch (error) {
        world.pageError = error instanceof Error ? error.message : String(error);
    }
    // `--attach` has no CLI: the runner did not boot this instance and has no sandbox to speak to.
    if (t.cli === undefined || t.cli === null) return world;
    try {
        const workspaces = JSON.parse(await t.cli.ok(['workspace', 'list', '--json']));
        world.workspaces = workspaces.map((workspace) => String(workspace.id));
        world.activeWorkspace = workspaces.find((workspace) => workspace.is_active === true)?.id ?? null;
        const web = [];
        for (const id of world.workspaces) {
            for (const pane of JSON.parse(await t.cli.ok(['pane', 'list', '--workspace', id, '--json']))) {
                if (pane.type === 'web') web.push(`${String(pane.id)} in ${String(pane.workspace_name ?? id)}`);
            }
        }
        world.webPanes = web;
    } catch (error) {
        world.cliError = error instanceof Error ? error.message : String(error);
    }
    return world;
}

const extras = (now, then) => (now ?? []).filter((item) => !(then ?? []).includes(item));

/** The lane this run opened, or `undefined` for the shipped window and for `--attach`. */
const lanePlacement = t.windowPlacement;

/** Everything `now` holds that the run started without, each as one readable phrase. */
function leaksAgainst(now, start) {
    const found = [];
    // A reading that could not be taken is not a clean one. Both of these used to be captured and
    // never looked at, so a page that had gone or a CLI that refused recorded as "nothing leaked".
    if (now.pageError !== undefined) found.push(`the window could not be read after this scenario: ${String(now.pageError)}`);
    if (now.cliError !== undefined) found.push(`the sandbox could not be read after this scenario: ${String(now.cliError)}`);
    if (now.page !== null && start.page !== null) {
        if (now.page.phonePlace !== null && now.page.phoneLanding !== true) {
            found.push(`the phone's remembered place is still set (${String(now.page.phonePlace)}); the next phone scenario opens there instead of on the landing page`);
        }
        for (const [id, view] of Object.entries(now.page.workbench)) {
            if (start.page.workbench[id] === view) continue;
            const [slot, daemon] = id.split(' @ ');
            found.push(`the workbench slot "${slot}" still names the plugin view ${view} (in this window's store for daemon ${String(daemon)})`);
        }
        if (now.page.settingsOpen && !start.page.settingsOpen) found.push('the Settings overlay is still open');
        for (const overlay of extras(now.page.overlays, start.page.overlays)) found.push(`${overlay} is still on screen`);
        /*
         * Not a diff: a focused page is the lane's own invariant, not a property of whatever this
         * run started with. `boot` turns CDP focus emulation on before a scenario runs a line
         * (driver.mjs ▸ setPageFocusEmulation), because the lane's window is never the key window,
         * and `harness.blur()` / `harness.hide()` turn it off on purpose. Comparing against the
         * first reading would have disarmed this check for the whole run whenever that first
         * reading caught the window still coming up - which is exactly what it did.
         */
        // Only when a lane was opened. Without `--window`, and under `--attach`, the window can be
        // the key window and the OS decides whether the page is focused: the machine's owner
        // clicking something else is not a leak, and reporting it as one would teach a reader to
        // ignore the line that matters. In the lane the page believes it is focused because `boot`
        // turned CDP focus emulation on (driver.mjs ▸ setPageFocusEmulation), and the only things
        // that turn it off are `harness.blur()` and `harness.hide()`, which a scenario chooses.
        if (lanePlacement !== undefined && now.page.hasFocus !== true) {
            found.push('the page does not believe it is focused (a harness.blur() or hide() that was never undone); ⌘C, ⌘V and every navigator.clipboard call after this fail with "Document is not focused"');
        }
        if (now.page.viewport !== start.page.viewport) {
            found.push(`the viewport is ${String(now.page.viewport)}, was ${String(start.page.viewport)} (device metrics left overridden)`);
        }
        if (now.page.url !== start.page.url) found.push(`the window is on ${String(now.page.url)}, was ${String(start.page.url)}`);
    }
    if (now.activeWorkspace !== null && now.activeWorkspace !== start.activeWorkspace) {
        found.push(`the active workspace is ${String(now.activeWorkspace)}, was ${String(start.activeWorkspace)}`);
    }
    for (const id of extras(now.workspaces, start.workspaces)) found.push(`workspace ${id} was left behind`);
    for (const pane of extras(now.webPanes, start.webPanes)) found.push(`web pane ${pane} was left open`);
    return found;
}

// ── the run ─────────────────────────────────────────────────────────────────────────

// One sandbox, many scenarios is the only shape where the post-condition means anything: a
// single-scenario run has nothing to hand on to.
const watchForLeaks = files.length > 1;
const startingWorld = watchForLeaks ? await readWorld() : null;
let previousLeaks = [];
const leakReport = [];
const summaries = [];
let anyFailed = false;
for (const file of files) {
    const name = path.basename(file, '.mjs');
    /*
     * The module is imported BEFORE anything is decided, because the decision is in it: a scenario
     * may declare the weakest window placement it can be trusted at (`lib/placement.mjs` has the
     * rule and the measurement), and a lane below that floor gives it an instance of its own at the
     * declared placement. A placement is fixed when the shell builds its window, so "raise it" can
     * only mean a second instance; that is the same `driver.boot` the browser and terminal
     * scenarios already use for their remote halves, so it is a proven 20 s, not a new mechanism.
     */
    let mod = null;
    let importError = null;
    try {
        mod = await import(pathToFileURL(file).href);
        if (typeof mod.default !== 'function') throw new Error(`${file} has no default export function`);
    } catch (error) {
        importError = error;
    }
    const resolved = resolveScenarioPlacement(t.windowPlacement, mod?.windowPlacement);
    let dedicated = null;
    if (resolved.raised && importError === null && attachPort === undefined) {
        log(`▶ ${name}: it declares ${String(resolved.placement)} and this run is ${String(t.windowPlacement)}; booting an instance of its own`);
        try {
            dedicated = await driver.boot({
                repoRoot,
                // Short on purpose: the sandbox's control socket lives in this label's temp
                // directory, and a macOS unix socket path is capped at 104 bytes. The full name
                // (`scenario-dock-bounce-stop-only`) overshot it, the daemon could not bind, and
                // the boot failed on a healthz timeout that said nothing about why.
                label: name.slice(0, 12),
                build: false,
                log: (line) => log(`  ${name}: ${line}`),
                window: resolved.placement
            });
        } catch (error) {
            log(`⚠ ${name}: the ${String(resolved.placement)} instance would not boot (${error instanceof Error ? error.message : String(error)}); running it in this lane instead`);
            dedicated = null;
        }
    }
    const instance = dedicated ?? t;
    const placement = instance.windowPlacement;
    log(`▶ ${name}  [window ${String(placement ?? 'attached')}${dedicated === null ? '' : ', its own instance'}]`);
    if (resolved.warning !== null) log(`⚠ ${name}: ${resolved.warning}`);
    const rec = driver.recorder({ name, outDir, placement });
    const started = Date.now();
    try {
        if (importError !== null) throw importError;
        await mod.default({
            page: instance.page,
            harness: instance.harness,
            cli: instance.cli,
            sandbox: instance.sandbox,
            // The shell's own stdout, for behaviour whose only external evidence is a log line
            // (the web-pane placement trail, `web pane <id> view owner=main|holder`). Null under
            // `--attach`, where this runner did not launch the shell and cannot read its pipe; a
            // scenario that needs it must say so rather than assume.
            shell: instance.shell ?? null,
            rec,
            d: driver,
            sleep: driver.sleep,
            repoRoot
        });
    } catch (error) {
        rec.check('the scenario ran to completion', false, error instanceof Error ? error.stack ?? error.message : String(error));
        try {
            await rec.shot(instance.page, 'on-error');
        } catch {
            /* the page may be gone */
        }
    } finally {
        if (dedicated !== null) {
            try { await dedicated.stop(); } catch { /* a sandbox that will not stop is not this run's verdict */ }
        }
    }
    const summary = { ...rec.summary(), ms: Date.now() - started, ...(dedicated === null ? {} : { ownInstance: true }) };
    summaries.push(summary);
    if (summary.failed > 0) anyFailed = true;
    log(`${summary.failed === 0 ? '✓' : '✗'} ${name}: ${String(summary.checks - summary.failed)}/${String(summary.checks)} checks in ${String(Math.round(summary.ms / 100) / 10)}s`);

    if (watchForLeaks && dedicated !== null) {
        // Its sandbox went with it, so it cannot have left anything in this one. Recorded as its
        // own answer rather than as an empty list, which would read as "checked, and clean".
        summary.leaked = null;
    } else if (watchForLeaks) {
        // Never fatal, and never allowed to end a run: this is housekeeping, and a reader that
        // cannot be read is worth nothing. A failure here is recorded as itself.
        let leaked = [];
        try {
            leaked = leaksAgainst(await readWorld(), startingWorld);
        } catch (error) {
            leaked = [`the post-condition could not be read: ${error instanceof Error ? error.message : String(error)}`];
        }
        summary.leaked = leaked;
        // Attribution, not accumulation: what this scenario ADDED to the pile is what its name
        // goes on. A leak that was already there belongs to whoever made it.
        const fresh = leaked.filter((item) => !previousLeaks.includes(item));
        if (fresh.length > 0) {
            leakReport.push({ name, leaked: fresh });
            log(`⚠ scenario ${name} leaked: ${fresh.join('; ')}`);
        }
        previousLeaks = leaked;
    }
}

if (watchForLeaks && leakReport.length > 0) {
    log(`⚠ ${String(leakReport.length)} scenario(s) left the sandbox changed; the next scenario starts from what they left:`);
    for (const entry of leakReport) for (const item of entry.leaked) log(`    ${entry.name}: ${item}`);
}

// The placement goes in the file, not just the terminal: a results.json read a week later must
// say whether its blank screenshots are a bug or the lane. So does the leak report: a scenario
// that goes red behind a leak is only readable next to the scenario that made it (#205).
fs.writeFileSync(
    path.join(outDir, 'results.json'),
    `${JSON.stringify({ stamp, windowPlacement: t.windowPlacement ?? 'attached', files, summaries, leaks: leakReport }, null, 2)}\n`
);
log(`results: ${path.join(outDir, 'results.json')}`);
await stop();
process.exit(anyFailed ? 1 : 0);
