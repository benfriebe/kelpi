#!/usr/bin/env node
/**
 * Does a window the machine's owner cannot see still produce the frames the audit measures?
 *
 * Taking the display back from a 20-minute audit run is only safe if the window that stops being
 * watched is still the same window. "The assertions still pass" is not evidence of that, because
 * most of them would pass against a compositor that quietly halved its frame rate: a slide sampled
 * 8 times instead of 15 still ends up open. The steps that would NOT survive it are the ones whose
 * measurement *is* a count of composited frames, or a colour read off one — and, as this
 * instrument found, the ones that measure a sub-pixel length, because a window AppKit no longer
 * considers to be on a screen loses its Retina backing store outright.
 *
 * So this compares MEASUREMENTS, placement against placement, with nothing else changed:
 *
 *   1. a raw rAF probe on both placements, on the audit's own stack: how many animation frames
 *      per second does each window actually get?
 *   2. the pixel-critical audit steps (`panel-slide-flash`, `window-transparency`,
 *      `terminal-cursor-focus` by default) run once per placement, and every numeric quantity in
 *      their assertion details and notes is extracted and diffed;
 *   3. `panel-slide-flash.mjs`, the CDP screencast instrument, runs on both placements. It counts
 *      real composited frames (`totals.inFlight`) and classifies their pixels, so it is the direct
 *      answer to "is the compositor skipping frames?" rather than a proxy for it;
 *   4. the SCREENSHOTS are weighed. A placement can be assertion-identical and still photograph
 *      nothing — which is exactly what a zero-opacity window does — and 107 of the audit's 118
 *      steps are `needs-eyes`, so that failure is the worst one available.
 *
 * A class that degrades goes in `lib/shards.mjs` ▸ `ONSCREEN_STEPS`, which gives that class a
 * shard with a visible window and leaves the rest of the run hidden.
 *
 * Usage:
 *
 *     node scripts/ui-audit/window-fidelity.mjs --out <dir> [--a hidden] [--b onscreen]
 *          [--steps a,b,c] [--no-screencast]
 *
 * Exit code 0 = every measured quantity matched within tolerance on both placements.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, waitForPageTarget } from './lib/cdp.mjs';
import { clearBackgroundTaskPolicy, makeSandbox, sleep, startDaemon, startShell, waitForHealthz } from './lib/stack.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : argv[index + 1];
};

const options = {
    out: path.resolve(repoRoot, flag('out', path.join('docs', 'audit', 'window-fidelity'))),
    steps: String(flag('steps', 'panel-slide-flash,window-transparency,terminal-cursor-focus'))
        .split(',')
        .filter(Boolean),
    screencast: !argv.includes('--no-screencast'),
    /**
     * How far two measurements of the same quantity may differ and still count as equal.
     *
     * Not zero: several of these numbers are honest per-run samples (a frame count over a
     * wall-clock animation, a load average, a measured pixel that lands on a subpixel boundary).
     * 10% catches "the compositor produced half the frames" — which is the failure this exists to
     * find — without flagging the ordinary jitter two runs of the SAME placement also show.
     */
    tolerance: Number(flag('tolerance', '0.1')),
    /**
     * The two placements to compare. The default pair reproduces the measurement that decided the
     * harness's own default: `offscreen` against `default`. `--a hidden --b default` reproduces
     * the other one — assertion-identical, blank pictures, which the screenshot check below is
     * what catches.
     */
    a: flag('a', 'offscreen'),
    b: flag('b', 'default')
};

const PLACEMENTS = [options.a, options.b];

fs.mkdirSync(options.out, { recursive: true });
const log = (line) => process.stdout.write(`${line}\n`);

function run(command, args, { cwd = repoRoot, logFile } = {}) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        clearBackgroundTaskPolicy(child.pid);
        let output = '';
        const sink = logFile === undefined ? null : fs.createWriteStream(logFile);
        for (const stream of [child.stdout, child.stderr]) {
            stream.setEncoding('utf8');
            stream.on('data', (chunk) => {
                output += chunk;
                sink?.write(chunk);
            });
        }
        child.on('close', (code) => resolve({ code: code ?? -1, output }));
        child.on('error', (error) => resolve({ code: -1, output: String(error) }));
    });
}

/** Every number in a string, with the surrounding text kept as the key. */
function numbersIn(text) {
    return [...String(text).matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
}

/**
 * The measured quantities of one audit step: every number in every assertion detail and note,
 * keyed by the assertion/note it came from.
 *
 * Keyed by TEXT rather than by index so a step whose assertion order shifted is reported as a
 * missing key instead of silently comparing two different quantities.
 */
function measurementsOf(step) {
    const measured = new Map();
    for (const assertion of step.assertions) {
        measured.set(`assert:${assertion.name}`, { ok: assertion.ok, numbers: numbersIn(assertion.detail), text: assertion.detail });
    }
    for (const note of step.notes) {
        const key = `note:${String(note).slice(0, 60)}`;
        measured.set(key, { ok: null, numbers: numbersIn(note), text: note });
    }
    return measured;
}

const VOLATILE = /clock|time|load|uptime|memory|cpu|\bpid\b|port|uuid|session|[0-9a-f]{8}-[0-9a-f]{4}/i;

function compareStep(id, left_, right_) {
    const rows = [];
    const a = measurementsOf(left_);
    const b = measurementsOf(right_);
    for (const [key, left] of a) {
        const right = b.get(key);
        if (right === undefined) {
            rows.push({ key, verdict: 'missing-b', a: left.text, b: null });
            continue;
        }
        if (left.ok !== right.ok) {
            rows.push({ key, verdict: 'VERDICT-DIFFERS', a: `${String(left.ok)} ${left.text}`, b: `${String(right.ok)} ${right.text}` });
            continue;
        }
        if (VOLATILE.test(key) || VOLATILE.test(left.text)) continue;
        if (left.numbers.length !== right.numbers.length) {
            rows.push({ key, verdict: 'SHAPE-DIFFERS', a: left.text, b: right.text });
            continue;
        }
        for (let i = 0; i < left.numbers.length; i++) {
            const x = left.numbers[i];
            const y = right.numbers[i];
            const scale = Math.max(Math.abs(x), Math.abs(y), 1);
            if (Math.abs(x - y) / scale > options.tolerance) {
                rows.push({ key, verdict: 'VALUE-DIFFERS', a: left.text, b: right.text, delta: `${String(x)} vs ${String(y)}` });
                break;
            }
        }
    }
    for (const key of b.keys()) if (!a.has(key)) rows.push({ key, verdict: 'missing-a', a: null, b: b.get(key).text });
    return { id, rows };
}

// ── 1. the raw frame clock ──────────────────────────────────────────────────────────

/**
 * The floor: how many rAF callbacks per second does each placement actually get?
 *
 * Measured on the audit's OWN stack — same sandbox, same shell, same `webPreferences`, the real
 * client page — rather than on a bare Electron script, so the number describes the window the
 * audit actually drives. This is the quantity every animation step ultimately rests on: a slide
 * that advances on a double rAF advances at this rate or not at all.
 */
async function frameClock(placement) {
    const sandbox = await makeSandbox(repoRoot, { label: `fidelity-${placement}`, clientDir: path.join(repoRoot, 'packages', 'client', 'dist') });
    const daemon = startDaemon(sandbox, { repoRoot });
    let shell = null;
    let page = null;
    try {
        await waitForHealthz(sandbox.base);
        shell = startShell(sandbox, { repoRoot, extraEnv: { KELPI_AUDIT: '1', KELPI_AUDIT_WINDOW: placement } });
        const target = await waitForPageTarget(sandbox.debugPort, {
            timeoutMs: 90_000,
            match: (candidate) => String(candidate?.url ?? '').includes('shellWindow=')
        });
        page = await connect(target.webSocketDebuggerUrl, { repoRoot });
        await page.send('Page.enable');
        await page.send('Runtime.enable');
        await page.send('Page.bringToFront').catch(() => {});
        await page.waitFor('document.querySelector(\'[data-testid="kelpi-app"]\') !== null', { timeoutMs: 60_000, label: 'the app to mount' });
        await sleep(1500);
        await page.eval(
            `(() => { window.__fidelityFrames = 0; window.__fidelityStart = performance.now();
                const tick = () => { window.__fidelityFrames += 1; requestAnimationFrame(tick); };
                requestAnimationFrame(tick); return true; })()`
        );
        await sleep(4000);
        const sample = await page.eval('({ frames: window.__fidelityFrames, ms: performance.now() - window.__fidelityStart })');
        return Math.round((sample.frames / sample.ms) * 1000 * 10) / 10;
    } finally {
        try {
            page?.close();
        } catch {
            // already gone
        }
        if (shell !== null) await shell.quit();
        await daemon.stop();
        sandbox.cleanup();
    }
}

// ── the run ─────────────────────────────────────────────────────────────────────────

const report = { placements: PLACEMENTS, tolerance: options.tolerance, frameClock: null, steps: [], screencast: null, screenshots: null, startedAt: new Date().toISOString() };
let failures = 0;

log(`window fidelity — ${options.a} vs ${options.b} — ${options.steps.join(', ')}\n`);

log('measuring the raw frame clock on both placements…');
report.frameClock = {};
for (const placement of PLACEMENTS) {
    try {
        report.frameClock[placement] = await frameClock(placement);
    } catch (error) {
        report.frameClock[placement] = null;
        log(`  ${placement}: probe failed — ${String(error?.message ?? error)}`);
    }
    log(`  ${placement}: ${String(report.frameClock[placement] ?? '?')} rAF/s`);
}
{
    const off = report.frameClock[options.a];
    const on = report.frameClock[options.b];
    if (typeof off === 'number' && typeof on === 'number' && on > 0) {
        // A real frame clock, not a frozen one, is the whole premise. Below a third of the
        // onscreen rate the window is being throttled rather than merely running slower, and no
        // amount of "the assertions passed" makes that safe.
        const ratio = off / on;
        log(`  ${options.a} runs at ${(ratio * 100).toFixed(0)}% of the ${options.b} frame rate`);
        if (ratio < 0.33) {
            failures += 1;
            log(`  ✗ the ${options.a} window is being throttled, not merely slowed`);
        }
    }
}

const stepResults = {};
for (const placement of PLACEMENTS) {
    const dir = path.join(options.out, `steps-${placement}`);
    log(`running the pixel-critical steps with the window ${placement}…`);
    const started = Date.now();
    const result = await run(
        process.execPath,
        [path.join(here, 'audit.mjs'), '--out', dir, '--no-build', '--window', placement, '--only', options.steps.join(',')],
        { logFile: path.join(options.out, `steps-${placement}.log`) }
    );
    const seconds = (Date.now() - started) / 1000;
    log(`  exit ${String(result.code)} in ${seconds.toFixed(0)}s`);
    stepResults[placement] = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'));
}

log('');
for (const id of options.steps) {
    const off = stepResults[options.a].steps.find((step) => step.id === id);
    const on = stepResults[options.b].steps.find((step) => step.id === id);
    if (off === undefined || on === undefined) {
        log(`✗ ${id}: one of the two runs produced no entry`);
        report.steps.push({ id, rows: [{ key: '(step)', verdict: 'MISSING' }] });
        failures += 1;
        continue;
    }
    const comparison = compareStep(id, off, on);
    const hard = comparison.rows.filter((row) => row.verdict !== 'missing-a' && row.verdict !== 'missing-b');
    report.steps.push({
        ...comparison,
        [`${options.a}Assertions`]: off.assertions.length,
        [`${options.b}Assertions`]: on.assertions.length,
        [`${options.a}Failed`]: off.assertions.filter((assertion) => !assertion.ok).length,
        [`${options.b}Failed`]: on.assertions.filter((assertion) => !assertion.ok).length
    });
    if (hard.length === 0) {
        log(`✓ ${id.padEnd(26)} ${String(off.assertions.length)} assertions, identical measurements on both placements`);
    } else {
        failures += 1;
        log(`✗ ${id.padEnd(26)} ${String(hard.length)} measurement(s) differ:`);
        for (const row of hard.slice(0, 8)) log(`      ${row.verdict}  ${row.key}\n        ${options.a}: ${row.a}\n        ${options.b}: ${row.b}`);
    }
}

// ── 2. the screencast instrument ────────────────────────────────────────────────────

if (options.screencast) {
    log('\nrunning the screencast instrument (panel-slide-flash.mjs) on both placements…');
    const totals = {};
    for (const placement of PLACEMENTS) {
        const dir = path.join(options.out, `screencast-${placement}`);
        const started = Date.now();
        const result = await run(
            process.execPath,
            [path.join(here, 'panel-slide-flash.mjs'), '--out', dir, '--cycles', '3', '--placement', placement],
            { logFile: path.join(options.out, `screencast-${placement}.log`) }
        );
        const seconds = (Date.now() - started) / 1000;
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
        totals[placement] = { ...parsed.totals, slides: parsed.slides.length, exit: result.code, seconds: Math.round(seconds) };
        log(`  ${placement}: exit ${String(result.code)} in ${seconds.toFixed(0)}s — ${JSON.stringify(parsed.totals)}`);
    }
    report.screencast = totals;
    /*
     * `inFlight` is the fidelity number: the count of screencast frames that landed mid-slide.
     * A compositor skipping real frames shows up here and nowhere else — the colour
     * verdicts would still be clean, because the frames that DID arrive are painted correctly.
     */
    const off = totals[options.a].inFlight;
    const on = totals[options.b].inFlight;
    const ratio = on === 0 ? 1 : off / on;
    log(`  mid-slide frames captured: ${options.a} ${String(off)} vs ${options.b} ${String(on)} (${(ratio * 100).toFixed(0)}% of ${options.b})`);
    if (ratio < 0.5) {
        failures += 1;
        log(`  ✗ the ${options.a} compositor produced fewer than half the frames — this class needs ONSCREEN_STEPS`);
    } else log(`  ✓ the ${options.a} compositor produced comparable frames`);
    for (const key of ['wrongColour', 'gridUncovered', 'alphaHoleFrames']) {
        if (totals[options.a][key] !== totals[options.b][key]) {
            failures += 1;
            log(`  ✗ ${key}: ${options.a} ${String(totals[options.a][key])} vs ${options.b} ${String(totals[options.b][key])}`);
        }
    }
}

// ── 4. did the screenshots survive? ─────────────────────────────────────────────────

/*
 * The check that nearly did not exist, and the one that mattered most.
 *
 * A zero-opacity window is assertion-identical to a visible one — every DOM query answers the
 * same — and writes PNGs that are entirely blank, because `Page.captureScreenshot` composites the
 * window's alpha even in the `fromSurface: false` mode the harness uses. 107 of the audit's 118
 * steps are `needs-eyes`; a placement that passes every assertion and photographs nothing has
 * destroyed the deliverable while looking perfect. Compare the bytes.
 *
 * Total compressed size rather than a pixel decode: a blank frame compresses to a fraction of a
 * real one (measured: 20 KB against 68 KB for the same step), and the ratio is unambiguous long
 * before it needs a tolerance argument.
 */
{
    const bytesFor = (placement) => {
        const dir = path.join(options.out, `steps-${placement}`);
        let total = 0;
        let count = 0;
        for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
            if (!name.endsWith('.png')) continue;
            total += fs.statSync(path.join(dir, name)).size;
            count += 1;
        }
        return { total, count };
    };
    const left = bytesFor(options.a);
    const right = bytesFor(options.b);
    report.screenshots = { [options.a]: left, [options.b]: right };
    const ratio = right.total === 0 ? 1 : left.total / right.total;
    log(
        `\nscreenshots: ${options.a} ${String(left.count)} files / ${String(Math.round(left.total / 1024))} KB · ` +
            `${options.b} ${String(right.count)} files / ${String(Math.round(right.total / 1024))} KB ` +
            `(${(ratio * 100).toFixed(0)}%)`
    );
    if (left.count !== right.count) {
        failures += 1;
        log('  ✗ the two placements did not produce the same number of screenshots');
    } else if (ratio < 0.5) {
        failures += 1;
        log(`  ✗ the ${options.a} screenshots carry a fraction of the detail — they are blank or half-resolution`);
    } else log('  ✓ the screenshots carry comparable detail');
}

report.finishedAt = new Date().toISOString();
report.failures = failures;
fs.writeFileSync(path.join(options.out, 'fidelity.json'), `${JSON.stringify(report, null, 2)}\n`);
log(`\n${failures === 0 ? `NO CLASS DEGRADES WITH THE WINDOW ${options.a.toUpperCase()}` : `${String(failures)} class(es) degrade with the window ${options.a}`} — report: ${path.join(options.out, 'fidelity.json')}`);
process.exitCode = failures === 0 ? 0 : 1;


