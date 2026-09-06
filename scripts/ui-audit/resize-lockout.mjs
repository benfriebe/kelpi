#!/usr/bin/env node
/**
 * Issue #79's live harness: does a sidebar drag ever STOP, and what does a width drag cost?
 *
 * The unit tests pin the sequencing (a `pointercancel` ends the drag, an unmount tears the
 * listeners down, `blur` resets both gestures) but every one of them runs in jsdom, which has
 * no compositor, no native views and no main thread to peg. The two things the issue is
 * actually about are (a) a `pointerup` that goes to a `WebContentsView` instead of to the
 * renderer, and (b) eight ghostty engines rewrapping 300 000 lines each while the user holds
 * the mouse down. Neither exists in jsdom. So this file stands up a real stack and asks it.
 *
 * The instrument is `web-view-revive.mjs`'s: a sandbox daemon on `mkdtemp` + `KELPID_*` +
 * ephemeral non-reserved ports, a real Electron shell, real PTYs, and CDP `Input.*` for every
 * gesture (never a synthesized DOM event, per ui-audit/README.md). On top of that, three things
 * this run needs and the other harnesses do not:
 *
 *   1. **A pointer-up that is really lost.** A CDP `mouseReleased` is delivered to the renderer
 *      whatever is composited over the point, so "release it over a web pane" cannot be spelled
 *      that way: it would be a release the renderer receives, i.e. the case that already worked.
 *      What the app actually experiences is the pair "no `pointerup` here" + "the window's focus
 *      went to the view", so this run reproduces exactly that pair - the sidebar's gesture is
 *      simply never released, and the focus change is driven through the shell's own harness
 *      channel (`packages/shell/src/harness.ts` ▸ `blur`, a real `BrowserWindow.blur()`).
 *
 *      Two things about that had to be measured rather than assumed, and both are load-bearing.
 *      CDP input does not move Electron's focus, so pressing into the web pane's own target
 *      leaves the renderer focused and delivers nothing (the press is still dispatched, and the
 *      fixture's counter reported in the notes says whether it registered). And a
 *      `BrowserWindow.blur()` on a window that is not the key window is a silent no-op - the
 *      first `focus()` of a run takes more than a second to land in the functional lane - which
 *      would make this probe pass on a tree with no fix in it. So the blur is retried until the
 *      PAGE's own `blur` counter moves, and every probe reports whether it was delivered.
 *   2. **A grid-coverage observer**, borrowed verbatim from `panel-slide-flash.mjs`'s §N31
 *      probe: a second `ResizeObserver` on the grid, created after the grid's own, that records
 *      how far the union of the pane wrappers falls short of the container it is inside. Above
 *      zero means a strip of window that nothing painted - the band `flushSync` was added to
 *      remove - and it is a DOM measurement, so it is trustworthy in the hidden lane where
 *      pixels are not.
 *   3. **A round-trip sampler**: `Runtime.evaluate` of a constant, every 50 ms, timed. It is
 *      the cheapest possible request of the renderer's main thread, so its latency IS the main
 *      thread's queue depth. p95 under 150 ms is the pass.
 *
 * What it asserts, each one a link in the issue's chain:
 *
 *   A. a sidebar drag whose release goes to a web pane leaves no `col-resize` cursor on the
 *      body, and a subsequent BARE mousemove does not move the sidebar;
 *   B. the same for a sidebar closed mid-drag with ⇧⌘S, which unmounts the handle;
 *   C. the divider drag ends the same way when the window loses focus;
 *   D. round trips during a 180 → 300 → 180 width drag over eight big panes: p95 < 150 ms;
 *   E. the drag paints no unpainted band (§N31's grid probe, worst uncovered px).
 *
 *     node scripts/ui-audit/resize-lockout.mjs [--build] [--verbose] [--keep]
 *          [--panes N] [--lines N] [--sweeps N] [--p95 MS]
 *          [--window hidden|offscreen|onscreen|default] [--out DIR]
 *
 * Exit code 0 = every assertion held. Run it against a tree with the fix reverted and A, B and
 * C fail while D and E pass: that is the shape of issue #79's lockout half.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valued = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
};
const options = {
    build: has('--build'),
    keep: has('--keep'),
    verbose: has('--verbose'),
    panes: Number(valued('--panes', '8')),
    lines: Number(valued('--lines', '300000')),
    sweeps: Number(valued('--sweeps', '2')),
    p95Ceiling: Number(valued('--p95', '150')),
    window: valued('--window', 'hidden'),
    out: valued('--out', null)
};

const { buildAll, makeSandbox, startDaemon, startShell, waitForHealthz, makeCli, assertSandboxDaemon, waitFor, sleep } =
    await import(path.join(repoRoot, 'scripts', 'ui-audit', 'lib', 'stack.mjs'));
const { waitForPageTarget, listTargets, connect, MOD } = await import(
    path.join(repoRoot, 'scripts', 'ui-audit', 'lib', 'cdp.mjs')
);
const { harnessClient } = await import(path.join(repoRoot, 'scripts', 'ui-audit', 'lib', 'driver.mjs'));

const results = [];
const notes = [];
const log = (line) => process.stdout.write(`${line}\n`);
function check(name, ok, detail = '') {
    results.push({ name, ok, detail });
    log(`  ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : `  ${detail}`}`);
}
function note(line) {
    notes.push(line);
    log(`    · ${line}`);
}

/** Something a click can land in, so the "release went to the web pane" step is a real press. */
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Lockout Fixture</title>
<style>html,body{margin:0;height:100%;background:#101014;color:#7ee787;font:20px/1.4 ui-monospace,monospace}
#t{padding:16px}</style></head><body><div id="t">clicks: 0</div>
<script>
  let n = 0;
  document.addEventListener('pointerdown', () => { n += 1; document.getElementById('t').textContent = 'clicks: ' + n; });
</script></body></html>`;

const percentile = (values, p) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index];
};
const round = (value, places = 1) => Math.round(value * 10 ** places) / 10 ** places;

// ── the §N31 grid-coverage probe, as `panel-slide-flash.mjs` states it ───────────────

const INSTALL_COVERAGE = `(() => {
    const grid = document.querySelector('[data-testid="pane-grid"]');
    if (grid === null || typeof ResizeObserver === 'undefined') return false;
    const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
    const observations = [];
    let running = true;
    const observer = new ResizeObserver(() => {
        if (!running) return;
        const g = box(grid);
        const wrappers = [...grid.querySelectorAll('[data-testid]')].filter((el) =>
            /^pane-[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(el.getAttribute('data-testid') ?? '') &&
            getComputedStyle(el).visibility !== 'hidden'
        );
        let u = null;
        for (const w of wrappers) {
            const b = box(w);
            u = u === null ? { ...b } : { l: Math.min(u.l, b.l), r: Math.max(u.r, b.r), t: Math.min(u.t, b.t), b: Math.max(u.b, b.b) };
        }
        const r2 = (value) => Math.round(value * 100) / 100;
        observations.push(
            u === null
                ? { wrappers: 0, uncovered: 0 }
                : { wrappers: wrappers.length, width: r2(g.r - g.l), uncovered: r2(Math.max(g.r - u.r, u.l - g.l, u.t - g.t, g.b - u.b)) }
        );
    });
    observer.observe(grid);
    window.__kelpiLockoutCoverage = { observations, stop: () => { running = false; observer.disconnect(); } };
    return true;
})()`;

async function main() {
    const outDir =
        options.out ?? path.join(repoRoot, 'docs', 'audit', 'resize-lockout', new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(outDir, { recursive: true });

    if (options.build) {
        log('building the tree (this is the default OFF; pass --build to force it)…');
        await buildAll(repoRoot, { log: (line) => log(`  ${line}`) });
    }
    const clientDir = path.join(repoRoot, 'packages', 'client', 'dist');
    if (!fs.existsSync(path.join(clientDir, 'index.html'))) {
        throw new Error(`the web client is not built: ${clientDir} (run with --build)`);
    }

    const site = await new Promise((resolve) => {
        const server = http.createServer((_request, response) => {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.end(FIXTURE);
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
    });

    const sandbox = await makeSandbox(repoRoot, { label: 'lockout', clientDir, auditWindow: options.window });
    const daemon = startDaemon(sandbox, { repoRoot, verbose: options.verbose });
    let shell = null;
    let page = null;
    let webSession = null;
    let harness = null;
    try {
        await waitForHealthz(sandbox.base);
        // Never a step before this one: prove the process on the sandbox port is the daemon this
        // script spawned and not the live app's.
        await assertSandboxDaemon(sandbox, daemon.child.pid);
        log(`  sandbox daemon pid ${String(daemon.child.pid)} on control ${String(sandbox.controlPort)}`);

        const cli = makeCli(sandbox, { repoRoot });
        shell = startShell(sandbox, {
            repoRoot,
            verbose: options.verbose,
            extraEnv: { KELPI_AUDIT: '1', KELPI_AUDIT_WINDOW: options.window }
        });

        const target = await waitForPageTarget(sandbox.debugPort, { match: (t) => t.url.includes('shellWindow=') });
        page = await connect(target.webSocketDebuggerUrl, { repoRoot, verbose: options.verbose });

        harness = harnessClient(sandbox.harnessSocket);
        await harness.ping();
        // A blur counter in the page, so "the renderer lost focus" is an observation rather than
        // an assumption about what `BrowserWindow.blur()` did.
        await page.eval(
            `(() => { window.__kelpiLockoutBlurs = 0; window.__kelpiLockoutCancels = 0;
              window.addEventListener('blur', () => { window.__kelpiLockoutBlurs += 1; });
              window.addEventListener('pointercancel', () => { window.__kelpiLockoutCancels += 1; }, true);
              return true; })()`
        );

        const created = await cli.run(['workspace', 'create', '--name', 'lockout'], { timeoutMs: 40_000 });
        if (created.code !== 0) throw new Error(`workspace create failed: ${created.stderr || created.stdout}`);
        await waitFor(
            'the workspace to be active on screen',
            async () =>
                (await page.eval(
                    `(document.querySelector('[data-testid="workspace-row"][data-active="true"]')?.textContent ?? '')
                        .includes('lockout')`
                )) === true,
            30_000
        );

        // ── the load: N shell panes, each with a real long history ──────────────────
        const paneIDs = JSON.parse(await cli.ok(['pane', 'list', '--json'])).map((entry) => entry.id ?? entry.pane_id);
        let anchor = paneIDs[0];
        const shells = [anchor];
        for (let index = 1; index < options.panes; index += 1) {
            const split = JSON.parse(
                await cli.ok([
                    'pane',
                    'split',
                    '--direction',
                    index % 2 === 0 ? 'vertical' : 'horizontal',
                    '--target',
                    anchor,
                    '--json'
                ])
            );
            const paneID = String(split.pane_id ?? '');
            if (paneID === '') throw new Error(`split ${String(index)} produced no pane: ${JSON.stringify(split)}`);
            shells.push(paneID);
            // Walk the anchor so the tree stays a real nest rather than a single spine.
            anchor = index % 3 === 0 ? shells[0] : paneID;
        }
        check(`${String(shells.length)} shell panes provisioned`, shells.length === options.panes, shells.join(' '));

        log(`  filling each pane with ${String(options.lines)} lines…`);
        for (const paneID of shells) {
            await cli.ok([
                'pane',
                'send',
                '--target',
                paneID,
                `yes kelpi-resize-lockout-fixture-line | head -${String(options.lines)}`
            ]);
        }
        // The panes stream concurrently; this is the settle, not a guess at the duration.
        await waitFor(
            'every pane to have finished printing its history',
            async () => {
                for (const paneID of shells) {
                    const tail = await cli.ok(['pane', 'capture', '--target', paneID]);
                    if (!tail.includes('kelpi-resize-lockout-fixture-line')) return false;
                }
                return true;
            },
            180_000,
            1000
        );
        await sleep(3000);

        const opened = await cli.run(['web', 'open', site.url], { timeoutMs: 60_000 });
        const webPaneID = (/open ok:\s*([0-9a-f-]{36})/i.exec(opened.stdout) ?? [])[1];
        check('a web pane is open to release the pointer into', webPaneID !== undefined, String(webPaneID));
        await sleep(2500);

        // The web pane's own web contents, which is where a release over it really lands.
        const webTarget = (await listTargets(sandbox.debugPort)).find((entry) => entry.url.startsWith(site.url));
        if (webTarget !== undefined) {
            webSession = await connect(webTarget.webSocketDebuggerUrl, { repoRoot, verbose: options.verbose });
        }
        note(
            webTarget === undefined
                ? 'the web pane has no CDP target; probe A falls back to simply never sending the release'
                : `web pane target ${webTarget.id}`
        );

        // ── page helpers ────────────────────────────────────────────────────────────

        const widthOf = () =>
            page.eval(
                `(() => { const el = document.querySelector('[data-testid="sidebar-resizer"]');
                  return el === null ? null : Math.round(el.parentElement.getBoundingClientRect().width); })()`
            );
        const bodyCursor = () => page.eval(`document.body.style.cursor`);
        const handleBox = () => page.box('[data-testid="sidebar-resizer"]');
        const sidebarOpen = () => page.eval(`document.querySelector('[data-testid="sidebar-resizer"]') !== null`);

        /** Put the sidebar back to a known width without leaving a gesture behind. */
        const settleWidth = async (target) => {
            const handle = await handleBox();
            if (handle === null) return null;
            const current = await widthOf();
            await page.drag(handle.cx, handle.cy, handle.cx + (target - current), handle.cy, { steps: 10 });
            await sleep(500);
            return await widthOf();
        };

        /**
         * One 180 → 300 → 180 sweep, as a sequence of moves with the button held. Returns the
         * pointer x it ended on, so the caller can decide how the gesture is (not) released.
         */
        const sweep = async (startX, y, cycles) => {
            const base = await widthOf();
            await page.mouse('mouseMoved', startX, y, { button: 'none', buttons: 0 });
            await page.mouse('mousePressed', startX, y, { button: 'left', clickCount: 1 });
            let x = startX;
            for (let cycle = 0; cycle < cycles; cycle += 1) {
                for (const goal of [300, 180]) {
                    const targetX = startX + (goal - base);
                    const steps = 16;
                    for (let step = 1; step <= steps; step += 1) {
                        x = x + (targetX - x) / (steps - step + 1);
                        await page.mouse('mouseMoved', x, y, { button: 'left', buttons: 1 });
                        await sleep(16);
                    }
                }
            }
            return x;
        };

        /** A BARE move: no button held, the thing a stuck drag still tracks. */
        const bareMove = async (x, y) => {
            await page.mouse('mouseMoved', x, y, { button: 'none', buttons: 0 });
            await sleep(250);
        };

        /**
         * The release, as the app really loses it: the press lands in the web pane's own web
         * contents (which counts it), and the renderer's window loses focus to that view.
         *
         * The focus half goes through the shell's harness channel because CDP input does not
         * move Electron's focus - see the module note. It is `BrowserWindow.blur()`, the same
         * event the renderer gets when a native view takes the key focus or the Space switches.
         */
        const releaseIntoWebPane = async () => {
            let landed = null;
            if (webSession !== null) {
                await webSession.mouse('mousePressed', 40, 40, { button: 'left', clickCount: 1 });
                await webSession.mouse('mouseReleased', 40, 40, { button: 'left', clickCount: 1 });
                await sleep(200);
                landed = String(await webSession.eval(`document.getElementById('t').textContent`));
            }
            /*
             * The DOM event, not the request: `BrowserWindow.blur()` on a window that is not the
             * key window is a no-op and delivers nothing, which would make this probe pass on a
             * tree with no fix in it. So the focus is taken and the blur retried until the page
             * says it saw one - measured, the very first `focus()` of a run needs more than a
             * second to land in the functional lane and a single-shot blur silently did nothing.
             */
            const before = Number(await page.eval(`window.__kelpiLockoutBlurs ?? -1`));
            let delivered = false;
            for (let attempt = 0; attempt < 5 && !delivered; attempt += 1) {
                await harness.focus();
                await sleep(700);
                await harness.blur();
                delivered = await waitFor(
                    'the renderer to receive the blur',
                    async () => Number(await page.eval(`window.__kelpiLockoutBlurs ?? -1`)) > before,
                    3_000
                ).then(
                    () => true,
                    () => false
                );
            }
            await sleep(600);
            return { landed, delivered, cancels: Number(await page.eval(`window.__kelpiLockoutCancels ?? -1`)) };
        };

        /**
         * The window has to hold the focus before it can lose it, and `focus()` is not instant.
         *
         * Deliberately not gated on `harness.window().focused`: in the functional lane the window
         * is painted at zero opacity and `isFocused()` can stay false while the renderer's own
         * focus is real - measured, the run where this was a hard gate timed out at 10 s on a
         * window that then blurred perfectly well. The observation that matters is the DOM
         * `blur` the page counts, and `releaseIntoWebPane` waits for exactly that.
         */
        const ensureFocused = async () => {
            await harness.focus();
            await sleep(1200);
        };

        // ── A. the release goes to the web pane ─────────────────────────────────────

        log('  A: a sidebar drag whose pointer-up lands in a web pane');
        await ensureFocused();
        await settleWidth(180);
        let handle = await handleBox();
        if (handle === null) throw new Error('the sidebar resize handle is not on screen');
        const endedAt = await sweep(handle.cx, handle.cy, options.sweeps);
        const draggedWidth = await widthOf();
        note(`the drag ended at ${String(draggedWidth)} px with the button still down`);

        const releaseA = await releaseIntoWebPane();
        note(
            `the web pane's fixture read back "${String(releaseA.landed)}"; ` +
                `blur delivered to the renderer: ${String(releaseA.delivered)}; ` +
                `pointercancels seen: ${String(releaseA.cancels)}`
        );

        const cursorAfterA = String(await bodyCursor());
        check(
            'A1: no col-resize cursor is left on the body',
            cursorAfterA === '',
            cursorAfterA === ''
                ? `body.style.cursor is empty (blur delivered: ${String(releaseA.delivered)})`
                : `ISSUE #79: body.style.cursor = "${cursorAfterA}" (blur delivered: ${String(releaseA.delivered)})`
        );
        await bareMove(endedAt + 260, handle.cy);
        const afterBareA = await widthOf();
        check(
            'A2: a bare mousemove afterwards does not move the sidebar',
            afterBareA === draggedWidth,
            `${String(draggedWidth)} → ${String(afterBareA)} px`
        );

        // ── B. the sidebar closes mid-drag ──────────────────────────────────────────

        log('  B: ⇧⌘S closes the sidebar mid-drag, unmounting the handle');
        await settleWidth(180);
        handle = await handleBox();
        const endedAtB = await sweep(handle.cx, handle.cy, 1);
        const widthAtClose = await widthOf();
        await page.key('KeyS', { modifiers: MOD.meta | MOD.shift });
        await waitFor('the sidebar to close', async () => (await sidebarOpen()) === false, 8_000).catch(() => {});
        await sleep(400);

        const cursorAfterB = String(await bodyCursor());
        check(
            'B1: closing mid-drag leaves no col-resize cursor',
            cursorAfterB === '',
            cursorAfterB === '' ? 'body.style.cursor is empty' : `ISSUE #79: body.style.cursor = "${cursorAfterB}"`
        );
        // The stuck drag's signature: the orphaned listener keeps writing the width while the
        // sidebar is not even on screen, so it comes back somewhere else entirely. ONE move, and
        // one that lands well clear of `widthAtClose`, so a stuck drag cannot pass by returning
        // to where it started.
        await bareMove(endedAtB + 400, handle.cy);
        await page.key('KeyS', { modifiers: MOD.meta | MOD.shift });
        await waitFor('the sidebar to reopen', async () => (await sidebarOpen()) === true, 8_000).catch(() => {});
        await sleep(700);
        const afterReopen = await widthOf();
        check(
            'B2: bare moves while it was closed did not resize it',
            afterReopen === widthAtClose,
            `${String(widthAtClose)} → ${String(afterReopen)} px`
        );

        // ── C. the divider drag ends when the window loses focus ────────────────────

        log('  C: a divider drag whose release lands in a web pane');
        await ensureFocused();
        const dividerBox = await page.eval(
            `(() => { const el = document.querySelector('[data-testid^="divider-"]');
              if (el === null) return null; const r = el.getBoundingClientRect();
              return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`
        );
        if (dividerBox === null) {
            check('C: a divider is on screen to drag', false, 'no divider element');
        } else {
            await page.mouse('mouseMoved', dividerBox.cx, dividerBox.cy, { button: 'none', buttons: 0 });
            await page.mouse('mousePressed', dividerBox.cx, dividerBox.cy, { button: 'left', clickCount: 1 });
            for (let step = 1; step <= 10; step += 1) {
                await page.mouse('mouseMoved', dividerBox.cx + step * 6, dividerBox.cy, { button: 'left', buttons: 1 });
                await sleep(16);
            }
            const activeDuring = await page.eval(
                `document.querySelectorAll('[data-testid^="divider-"][data-dragging="true"]').length`
            );
            const releaseC = await releaseIntoWebPane();
            note(
                `blur delivered: ${String(releaseC.delivered)}; pointercancels seen: ${String(releaseC.cancels)}`
            );
            const activeAfter = await page.eval(
                `document.querySelectorAll('[data-testid^="divider-"][data-dragging="true"]').length`
            );
            note(`dividers marked dragging: ${String(activeDuring)} during, ${String(activeAfter)} after`);
            check(
                'C1: no divider is left marked as dragging',
                Number(activeAfter) === 0,
                `${String(activeAfter)} still dragging`
            );
        }

        // ── D + E. the cost of a width drag, and the band it paints ─────────────────

        log('  D/E: round-trip latency and the §N31 grid band during a width drag');
        await page.key('KeyS', { modifiers: MOD.meta | MOD.shift });
        await sleep(300);
        await page.key('KeyS', { modifiers: MOD.meta | MOD.shift });
        await sleep(900);
        await settleWidth(180);

        const installed = await page.eval(INSTALL_COVERAGE);
        note(`grid coverage observer installed: ${String(installed)}`);

        const latencies = [];
        let sampling = true;
        const sampler = (async () => {
            while (sampling) {
                const started = Date.now();
                try {
                    await page.eval('1', 20_000);
                    latencies.push(Date.now() - started);
                } catch {
                    latencies.push(20_000);
                }
                await sleep(50);
            }
        })();

        handle = await handleBox();
        const dragEnd = await sweep(handle.cx, handle.cy, options.sweeps);
        await page.mouse('mouseReleased', dragEnd, handle.cy, { button: 'left', clickCount: 1 });
        sampling = false;
        await sampler;

        const coverage = JSON.parse(
            String(
                await page.eval(
                    `(() => { window.__kelpiLockoutCoverage?.stop?.();
                      return JSON.stringify(window.__kelpiLockoutCoverage?.observations ?? []); })()`
                )
            )
        );
        const observed = coverage.filter((entry) => entry.wrappers > 0);
        const banded = observed.filter((entry) => entry.uncovered > 0.51);
        const worstBand = observed.reduce((high, entry) => Math.max(high, entry.uncovered), 0);

        const p50 = percentile(latencies, 50);
        const p95 = percentile(latencies, 95);
        const worst = latencies.length === 0 ? 0 : Math.max(...latencies);
        note(
            `round trips: n=${String(latencies.length)} p50=${String(p50)}ms p95=${String(p95)}ms max=${String(worst)}ms`
        );
        note(
            `grid band: ${String(banded.length)}/${String(observed.length)} observations uncovered ` +
                `(worst ${String(round(worstBand, 2))} CSS px)`
        );
        check(
            `D: p95 round trip during the drag is under ${String(options.p95Ceiling)} ms`,
            p95 < options.p95Ceiling,
            `p50 ${String(p50)} ms · p95 ${String(p95)} ms · max ${String(worst)} ms over ${String(latencies.length)} samples`
        );
        check(
            'E: the drag paints no unpainted band (§N31)',
            banded.length === 0,
            `worst ${String(round(worstBand, 2))} CSS px over ${String(observed.length)} observations`
        );

        fs.writeFileSync(
            path.join(outDir, 'report.json'),
            `${JSON.stringify(
                {
                    options,
                    results,
                    notes,
                    latency: { samples: latencies.length, p50, p95, max: worst, values: latencies },
                    grid: { observations: observed.length, banded: banded.length, worstUncoveredPx: worstBand }
                },
                null,
                2
            )}\n`
        );
        log(`  report: ${path.join(outDir, 'report.json')}`);
    } finally {
        try {
            site.server.close();
        } catch {
            /* already closed */
        }
        try {
            harness?.close();
        } catch {
            /* already gone */
        }
        for (const session of [webSession, page]) {
            try {
                await session?.close?.();
            } catch {
                /* already gone */
            }
        }
        if (!options.keep) {
            try {
                await shell?.quit?.();
            } catch {
                /* already gone */
            }
            try {
                await daemon.stop();
            } catch {
                /* already gone */
            }
            sandbox.cleanup?.();
        } else {
            log(`  --keep: sandbox left at ${sandbox.root}`);
        }
    }

    const failed = results.filter((entry) => !entry.ok);
    log('');
    log(`${String(results.length - failed.length)}/${String(results.length)} assertions held`);
    if (failed.length > 0) {
        for (const entry of failed) log(`  FAILED: ${entry.name} ${entry.detail}`);
        process.exitCode = 1;
    }
}

main().catch((error) => {
    log(`\nharness error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 1;
});
