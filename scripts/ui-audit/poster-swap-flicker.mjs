#!/usr/bin/env node
/**
 * Issue #12's frame-level harness: what does the SCREEN do when a menu opens over a web pane?
 *
 * The poster mechanism (`client/src/webpane/poster.ts`) has unit cover for its ordering and an
 * audit step for its settled state, and both were green while the promoted build visibly
 * flickered and jumped. That is the gap this file exists to close: jsdom has no compositor and a
 * settled screenshot has no time axis, so neither could see a swap that is only wrong for two
 * frames.
 *
 * The instrument, in the shape `panel-slide-flash.mjs` established:
 *
 *   1. **An in-page rAF sampler** — per composited frame: does the pane's hole hold a poster,
 *      what box is it in, what does `data-visible` say, and what is the wall clock. A frame is
 *      the unit the report is in, so it is the unit the harness measures in.
 *   2. **The shell's own lines, stamped as they arrive** — `view owner=main|holder` is the only
 *      observable for "the native view is being drawn", because a `WebContentsView` is composited
 *      by the window and never appears in the renderer's own frames (a `Page.startScreencast`
 *      of this window shows the hole as EMPTY even while the page is live, which is why the cast
 *      the panel harness uses cannot answer this question).
 *   3. **The two clocks, merged.** Both streams are wall-clock, so "the view left before the
 *      picture arrived" is arithmetic rather than an opinion.
 *
 * **Known bias, and it is the safe direction.** The shell's timestamps are taken when its line
 * reaches this process's stdout pipe, which is AFTER the moment it logged — so a loaded machine
 * makes the park look later than it was and the ordering check under-detects. It cannot produce a
 * false red: a run that says "painted 3 ms before the park" may in truth have been 1 ms, but a run
 * that says "painted 8 ms after" cannot have been before. Reds are therefore trustworthy and a
 * thin green margin is worth re-running.
 *
 * **Round 3 rewrote the conditions, because the instrument passed a build the owner rejected.**
 * Two of them were wrong, and both flattered the fix:
 *
 *   - The fixture was CHEAP. A page of fixed-height rows relayouts in three milliseconds and
 *     looks identical at 1280 px and at 525 px, so it could not show a relayout and its capture
 *     always beat the deadline. Real pages are busy: this one has a 450 ms `resize` handler and a
 *     column count that depends on width, which is what a React app costs on a good day.
 *   - Nothing watched the GUEST PAGE. Everything was sampled in the client's renderer and in the
 *     shell's log, and the page's own layout — the thing that actually moves — was never read.
 *     The park used to re-pin it to the automation viewport, so the page reflowed out and back
 *     and the frames after a menu closed showed a 1280 px layout clipped into a 525 px pane.
 *
 * So the page is sampled from the inside now, and the run is only green if the page's viewport
 * never changes at all.
 *
 * What it asserts, and each one is a defect that shipped:
 *
 *   - **The picture is on screen BEFORE the view leaves.** The park is a socket message the shell
 *     acts on in about a millisecond; an `<img>` committed in the same tick cannot appear before
 *     the next composited frame. Measured on the promoted build: the view left 12 ms before the
 *     image existed, i.e. one to two frames of empty pane, which is the flicker.
 *   - **No frame between park and restore is without the poster.** The same statement from the
 *     other side, over every frame rather than at the edges.
 *   - **The poster stands exactly where the view stood.** `viewBounds` rounds and clamps every
 *     edge, and an `<img>` given only insets keeps its intrinsic aspect under Tailwind's
 *     `img{max-width:100%;height:auto}`: on a 2× display a 1050×1412 capture was laid out as
 *     528.99×711.38 where the view had been 525×706, so the page grew 0.76% when the menu opened
 *     and snapped back when it closed. That is the jump.
 *   - **The frame is 1:1 in device pixels** (natural size = box × dpr), so the picture is not a
 *     resampled, softer copy of the page it stands in for.
 *   - **The picture outlives the restore**, so the swap back has no gap either.
 *
 *     node scripts/ui-audit/poster-swap-flicker.mjs [--window hidden|offscreen|onscreen|default]
 *          [--no-build] [--keep] [--verbose] [--out DIR]
 *
 * Exit code 0 = every assertion held. **`--window hidden` is the meaningful default**: it keeps
 * the real 2× backing scale, and the whole geometry defect above is invisible at 1× (where the
 * capture's intrinsic size happens to equal the view's box).
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
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
    build: !has('--no-build'),
    keep: has('--keep'),
    verbose: has('--verbose'),
    /**
     * `--packaged` runs the shipped bundle, which is what the owner actually uses. Round 3 exists
     * because a dev-shell-only gate passed a build the owner rejected; the packaged run is the
     * one that answers "does the app on their machine still do it".
     */
    packaged: has('--packaged'),
    window: valued('--window', 'default'),
    out: valued('--out', null)
};

const { buildAll, makeSandbox, startDaemon, startShell, waitForHealthz, makeCli, waitFor, sleep, packagedApp } =
    await import(path.join(repoRoot, 'scripts', 'ui-audit', 'lib', 'stack.mjs'));

/**
 * Wait until a sample stops changing — the audit's own `settleStable`, inlined because
 * `audit.mjs` does not export it. Preferred over a fixed sleep wherever the thing being waited
 * for is observable: a duration is a guess that is too short on a loaded machine and wasted on a
 * fast one, and here the waits bracket the very measurement being taken.
 */
async function settleStable(sample, { ceilingMs, stableMs = 300, intervalMs = 70 }) {
    const started = Date.now();
    let last = null;
    let since = Date.now();
    while (Date.now() - started < ceilingMs) {
        const value = await sample();
        if (value !== last) {
            last = value;
            since = Date.now();
        } else if (Date.now() - since >= stableMs) {
            return value;
        }
        await sleep(intervalMs);
    }
    return last;
}
const { waitForPageTarget, connect } = await import(path.join(repoRoot, 'scripts', 'ui-audit', 'lib', 'cdp.mjs'));

const results = [];
const log = (line) => process.stdout.write(`${line}\n`);
function check(name, ok, detail = '') {
    results.push({ name, ok });
    log(`  ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : `  ${detail}`}`);
}

/**
 * The fixture, and every part of it is load-bearing.
 *
 *   - **The column count depends on the width**, so a relayout to the automation viewport is
 *     visible in a still: four columns squeezed into a one-column pane.
 *   - **The relayout COSTS something** (2500 cards, and a `resize` handler that blocks for
 *     450 ms), because a page that relayouts instantly hides the window this harness measures,
 *     and because a busy main thread is what made the old CDP capture miss its deadline.
 *   - **A HUD prints the page's own viewport**, so a photograph carries its own diagnosis.
 */
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Poster Swap Fixture</title>
<style>
  html,body{margin:0;padding:0;background:#101014;color:#fff;font:13px/20px ui-monospace,monospace}
  #grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:8px}
  @media (max-width: 900px){ #grid{grid-template-columns:repeat(2,1fr)} }
  @media (max-width: 600px){ #grid{grid-template-columns:1fr} }
  .card{background:#1d2330;border:1px solid #2c3648;border-radius:8px;padding:10px;height:70px}
  .card b{color:#7fd1ff}
  #hud{position:fixed;left:0;top:0;background:#000;color:#0f0;padding:4px 8px;z-index:9}
</style></head><body><div id="hud">booting</div><div id="grid"></div>
<script>
  const grid = document.getElementById('grid');
  for (let i = 0; i < 2500; i++) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<b>card ' + i + '</b><br>' + 'x'.repeat(20);
    grid.appendChild(card);
  }
  const block = (ms) => { const until = Date.now() + ms; while (Date.now() < until) { /* busy */ } };
  addEventListener('resize', () => block(450));
  // Busy ON DEMAND, so the harness can decide rather than hope. A page whose main thread is
  // occupied at the moment of the right-click is the ordinary case in a real app — you clicked
  // something a second ago — and it decides whether a capture served by that same main thread
  // can answer inside the client's deadline at all.
  window.__hog = (ms) => { setTimeout(() => block(ms), 0); return 'hogging ' + ms; };
  const hud = document.getElementById('hud');
  const paint = () => {
    hud.textContent = innerWidth + 'x' + innerHeight + ' @' + devicePixelRatio;
    requestAnimationFrame(paint);
  };
  requestAnimationFrame(paint);
</script></body></html>`;

async function main() {
    const outDir = options.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-poster-swap-'));
    fs.mkdirSync(outDir, { recursive: true });

    if (options.build) {
        log('building the tree (skip with --no-build)…');
        await buildAll(repoRoot, { log: (line) => log(`  ${line}`) });
    }
    // A packaged run drives the app's OWN staged client, main process and daemon, so every layer
    // under the measurement is the shipped bytes.
    const clientDir = options.packaged
        ? path.join(packagedApp(repoRoot), 'Contents', 'Resources', 'client')
        : path.join(repoRoot, 'packages', 'client', 'dist');
    if (!fs.existsSync(path.join(clientDir, 'index.html'))) {
        throw new Error(`the web client is not built: ${clientDir}`);
    }

    const site = await new Promise((resolve) => {
        const server = http.createServer((_request, response) => {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.end(FIXTURE);
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
    });

    const sandbox = await makeSandbox(repoRoot, { label: 'poster', clientDir, auditWindow: options.window });
    if (options.packaged) delete sandbox.env.KELPID_ENTRY;
    const daemon = startDaemon(sandbox, { repoRoot, verbose: options.verbose, packaged: options.packaged });
    let shell = null;
    let page = null;
    try {
        await waitForHealthz(sandbox.base);
        const cli = makeCli(sandbox, { repoRoot });
        shell = startShell(sandbox, {
            repoRoot,
            packaged: options.packaged,
            verbose: options.verbose,
            extraEnv: { KELPI_AUDIT: '1', KELPI_AUDIT_WINDOW: options.window }
        });

        // The shell's lines, stamped on arrival: the only observable for the native view.
        const stamps = [];
        let consumed = 0;
        const pump = setInterval(() => {
            while (consumed < shell.lines.length) {
                const line = shell.lines[consumed];
                consumed += 1;
                if (/view owner=|poster /.test(line)) stamps.push({ at: Date.now(), line: line.trim() });
            }
        }, 1);
        pump.unref?.();

        /*
         * The packaged app announces the port it actually listened on, and it is not always the
         * one the flag asked for — trust the announcement.
         */
        let debugPort = sandbox.debugPort;
        await waitFor(
            'the shell to announce its devtools port',
            async () => {
                const line = shell.lines.find((entry) => /DevTools listening on ws:\/\/127\.0\.0\.1:\d+/.test(entry));
                if (line === undefined) return false;
                debugPort = Number(/127\.0\.0\.1:(\d+)/.exec(line)[1]);
                return true;
            },
            options.packaged ? 180_000 : 60_000
        ).catch(() => undefined);
        const target = await waitForPageTarget(debugPort, {
            match: (t) => t.url.includes('shellWindow='),
            timeoutMs: options.packaged ? 180_000 : 60_000
        });
        page = await connect(target.webSocketDebuggerUrl, { repoRoot, verbose: options.verbose });

        const created = await cli.run(['workspace', 'create', '--name', 'poster-swap'], { timeoutMs: 40_000 });
        check('a scratch workspace for this run exists', created.code === 0, created.stdout.trim());
        await waitFor(
            'the workspace to be active on screen',
            async () =>
                (await page.eval(
                    `(document.querySelector('[data-testid="workspace-row"][data-active="true"]')?.textContent ?? '')
                        .includes('poster-swap')`
                )) === true,
            30_000
        );

        const opened = await cli.run(['web', 'open', site.url], { timeoutMs: 60_000 });
        const paneID = (/open ok:\s*([0-9a-f-]{36})/i.exec(opened.stdout) ?? [])[1];
        check('a web pane is open on the fixture', paneID !== undefined, opened.stdout.trim());
        if (paneID === undefined) throw new Error('no pane to measure');

        await waitFor(
            'the page hole to be placed',
            async () =>
                (await page.eval(
                    `document.querySelector('[data-testid="web-page-${paneID}"]')?.getAttribute('data-visible') === 'true'`
                )) === true,
            30_000
        );
        // The "before" frames must be steady, and "steady" is a measurement rather than a
        // duration: the hole has stopped moving and the shell has finished placing the view.
        await settleStable(
            async () =>
                String(
                    await page.eval(
                        `(() => { const el = document.querySelector('[data-testid="web-page-${paneID}"]');
                          const r = el.getBoundingClientRect();
                          return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height),
                                  el.getAttribute('data-visible')].join('/'); })()`
                    )
                ) + `|${String(stamps.length)}`,
            { ceilingMs: 3000, stableMs: 400, intervalMs: 80 }
        );

        /**
         * One pass: install both samplers, open the menu over the pane, close it, and assert what
         * THIS pass can see. `busy` decides which of the two symptoms is measurable — see the
         * comment at the gesture below.
         */
        let lastSampled = { frames: [], marks: [] };
        let lastGuest = [];
        const pass = async (label, busy) => {
            const passCheck = (name, ok, detail = '') => check(`[${label}] ${name}`, ok, detail);
            const stampsBefore = stamps.length;
            /*
             * The sampler that round 3 was missing: INSIDE the page. The client's renderer cannot see
             * how the guest is laid out, and that is the half that moves.
             */
            const installed = await cli.run(
                [
                    'web',
                    'exec',
                    '--target',
                    paneID,
                    `(() => { window.__guestNet = { frames: [] };
                      const tick = () => { window.__guestNet.frames.push([Date.now(), innerWidth, innerHeight, devicePixelRatio]);
                        requestAnimationFrame(tick); };
                      requestAnimationFrame(tick); return 'installed'; })()`
                ],
                { timeoutMs: 30_000 }
            );
            passCheck('a sampler is running inside the page', installed.code === 0, installed.stdout.trim().slice(0, 40));


            await page.eval(`(() => {
                window.__posterProbe = { frames: [], marks: [] };
                window.__posterMark = (name) => window.__posterProbe.marks.push({ name, at: Date.now() });
                const tick = () => {
                    const hole = document.querySelector('[data-testid="web-page-${paneID}"]');
                    const img = document.querySelector('[data-testid="web-poster-${paneID}"]');
                    const box = img === null ? null : img.getBoundingClientRect();
                    window.__posterProbe.frames.push({
                        at: Date.now(),
                        dpr: window.devicePixelRatio,
                        visible: hole === null ? null : hole.getAttribute('data-visible'),
                        covered: hole === null ? null : hole.getAttribute('data-overlay-covered'),
                        poster:
                            img === null
                                ? null
                                : { complete: img.complete, naturalW: img.naturalWidth, naturalH: img.naturalHeight,
                                    x: box.x, y: box.y, w: box.width, h: box.height }
                    });
                    requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
                return true;
            })()`);

            /*
             * TWO PASSES, because the two symptoms cannot be measured in the same one.
             *
             *   - **idle** — the page's own rAF sampler runs, so "was the page re-laid-out for the
             *     menu" is answerable. This is the jump.
             *   - **busy** — the page's main thread is occupied for longer than the client's whole
             *     patience, which is the ordinary case in a real app a second after you clicked
             *     something. A capture served BY that main thread cannot answer, and the pane parks
             *     with nothing: the blank. The in-page sampler is starved in this pass too, which is
             *     exactly why it needs its own.
             */
            if (busy) {
                await cli.run(['web', 'exec', '--target', paneID, 'window.__hog(1500)'], { timeoutMs: 30_000 });
            }
            await page.eval(`window.__posterMark('open')`);
            await page.rightClick(`[data-testid="pane-header-${paneID}"]`);
            await waitFor(
                'the menu to be up',
                async () => (await page.eval(`document.querySelector('[data-testid="context-menu"]') !== null`)) === true,
                10_000
            );
            // Parked and settled: the frame is up, the shell has logged its park, and the sampler has
            // seen several frames of the steady state.
            await settleStable(
                async () =>
                    String(
                        await page.eval(
                            `(() => { const net = window.__posterProbe;
                              const last = net.frames[net.frames.length - 1];
                              return [last?.visible ?? null, last?.poster === null || last?.poster === undefined
                                  ? '-' : Math.round(last.poster.w) + 'x' + Math.round(last.poster.h)].join('/'); })()`
                        )
                    ) + `|${String(stamps.length)}`,
                { ceilingMs: 2500, stableMs: 400, intervalMs: 80 }
            );
            await page.eval(`window.__posterMark('close')`);
            await page.key('Escape');
            // …and restored: the view is back and the linger has expired, which is the last thing any
            // assertion below reads.
            await settleStable(
                async () =>
                    String(
                        await page.eval(
                            `(() => { const net = window.__posterProbe;
                              const last = net.frames[net.frames.length - 1];
                              return [last?.visible ?? null, last?.poster === null ? '-' : 'poster'].join('/'); })()`
                        )
                    ) + `|${String(stamps.length)}`,
                { ceilingMs: 2500, stableMs: 400, intervalMs: 80 }
            );

            const probe = await page.eval(`JSON.stringify(window.__posterProbe)`);
            const sampled = JSON.parse(String(probe));
            lastSampled = sampled;
            fs.writeFileSync(path.join(outDir, 'frames.json'), JSON.stringify(sampled, null, 2));
            fs.writeFileSync(path.join(outDir, 'shell.log'), shell.text());

            // ── the two clocks, merged ──────────────────────────────────────────────────
            /*
             * Three placement states since issue #12's round 3, and a transient park is the middle
             * one: `owner=main hidden` is in this window, at these bounds, not composited. The old
             * reading (`owner=holder`) would now miss the park entirely and pass by accident.
             */
            const passStamps = stamps.slice(stampsBefore);
            const parked = passStamps.find(
                (stamp) => stamp.line.includes('owner=main hidden') || stamp.line.includes('owner=holder')
            );
            const restored = passStamps.find(
                (stamp) =>
                    stamp.line.includes('owner=main') &&
                    !stamp.line.includes('hidden') &&
                    parked !== undefined &&
                    stamp.at > parked.at
            );
            const placement = [...stamps]
                .reverse()
                .find((stamp) => /owner=main bounds=(\d+),(\d+) (\d+)×(\d+)/.test(stamp.line));
            passCheck('the shell parked the view for the menu', parked !== undefined, parked?.line ?? '(no owner=holder line)');
            passCheck('…and handed it back when the menu closed', restored !== undefined, restored?.line ?? '(no restore)');
            if (parked === undefined || restored === undefined || placement === undefined) {
                // Diagnosis beats a stack trace: the shell's own lines say what it did instead.
                log(`  shell lines this pass:\n${passStamps.map((stamp) => `    ${stamp.line}`).join('\n') || '    (none)'}`);
                log(`  last shell lines:\n${shell.lines.slice(-10).map((line) => `    ${line}`).join('\n')}`);
                return;
            }
            const [, bx, by, bw, bh] = /owner=main bounds=(\d+),(\d+) (\d+)×(\d+)/.exec(placement.line);
            const bounds = { x: Number(bx), y: Number(by), w: Number(bw), h: Number(bh) };

            const frames = sampled.frames;
            const withPoster = (frame) => frame.poster !== null;
            const firstPoster = frames.find(withPoster);

            // 1 — the picture is on screen BEFORE the view leaves.
            //
            // "On screen" is the frame AFTER the one that first carried it: a rAF callback runs
            // before its own frame is composited, so the sample that first sees the element is the
            // frame in which it is painted, and the one after it is the proof it stayed.
            const paintedAt = firstPoster === undefined ? null : frames[frames.indexOf(firstPoster) + 1]?.at ?? null;
            passCheck(
                'the still frame is painted BEFORE the view is handed back',
                paintedAt !== null && paintedAt <= parked.at,
                paintedAt === null
                    ? '(no poster frame at all)'
                    : `the picture appeared ${String(parked.at - firstPoster.at)}ms and was painted ` +
                      `${String(parked.at - paintedAt)}ms before the view left ` +
                      `(negative = the empty gap the owner saw)`
            );

            // 2 — no frame between park and restore is without it.
            const between = frames.filter((frame) => frame.at >= parked.at && frame.at <= restored.at);
            const blanks = between.filter((frame) => frame.poster === null);
            passCheck(
                'no frame between park and restore shows an empty hole',
                between.length > 0 && blanks.length === 0,
                `${String(between.length - blanks.length)}/${String(between.length)} frames carried the picture`
            );

            // 3 — it stands exactly where the view stood.
            const boxes = [...new Set(between.filter(withPoster).map((frame) => `${frame.poster.x},${frame.poster.y} ${frame.poster.w}×${frame.poster.h}`))];
            const sample = between.find(withPoster);
            passCheck(
                'the picture stands exactly on the box the shell placed the view at',
                sample !== undefined &&
                    sample.poster.x === bounds.x &&
                    sample.poster.y === bounds.y &&
                    sample.poster.w === bounds.w &&
                    sample.poster.h === bounds.h,
                `poster ${boxes.join(' | ')} vs view ${String(bounds.x)},${String(bounds.y)} ${String(bounds.w)}×${String(bounds.h)}`
            );

            // 4 — 1:1 in device pixels, so it is the page rather than a resampled copy of it.
            passCheck(
                'the frame is 1:1 in device pixels (no resampling)',
                sample !== undefined &&
                    sample.poster.naturalW === Math.round(sample.poster.w * sample.dpr) &&
                    sample.poster.naturalH === Math.round(sample.poster.h * sample.dpr),
                sample === undefined
                    ? '(no poster)'
                    : `natural ${String(sample.poster.naturalW)}×${String(sample.poster.naturalH)} ` +
                      `at dpr ${String(sample.dpr)} for ${String(sample.poster.w)}×${String(sample.poster.h)}`
            );

            // 5 — and it outlives the restore, so the swap back has no gap either.
            const afterRestore = frames.filter((frame) => frame.at > restored.at).slice(0, 3);
            passCheck(
                'the picture is still there for the frames after the view comes back',
                afterRestore.length > 0 && afterRestore.every(withPoster),
                `${String(afterRestore.filter(withPoster).length)}/${String(afterRestore.length)} frames`
            );

            // …and eventually goes, or the pane would keep a stale photograph for ever.
            const lastFrames = frames.slice(-3);
            passCheck(
                'and it is gone once the live view has had time to paint',
                lastFrames.length > 0 && lastFrames.every((frame) => frame.poster === null),
                `${String(lastFrames.filter((frame) => frame.poster === null).length)}/${String(lastFrames.length)} final frames`
            );

            /*
             * A refusal is a blank pane, which is issue #12 itself. It happens when the capture
             * cannot be served: the old path asked the page's own main thread for a frame, so a busy
             * page (this one) missed the client's 250 ms deadline and the pane parked with nothing.
             * `webContents.capturePage` is served by the browser process and does not care.
             */
            const refusals = shell.lines.filter((line) => line.includes('poster refused'));
            // Reported, not asserted: a host refusal is one way the pane ends up blank, and the
            // deadline firing before the host answers at all is another. What the pass ASSERTS is
            // the outcome — that the hole wore a picture — which covers both.
            if (busy) log(`  [busy] host refusals: ${refusals.at(-1)?.trim() ?? 'none'}`);

            // ── the page's own layout, across the whole gesture ─────────────────────────
            const guestOut = await cli.run(
                ['web', 'exec', '--target', paneID, 'JSON.stringify(window.__guestNet.frames)'],
                { timeoutMs: 30_000 }
            );
            let guestFrames = [];
            try {
                const raw = guestOut.stdout.trim().replace(/^result:\s*/, '');
                const once = JSON.parse(raw);
                guestFrames = typeof once === 'string' ? JSON.parse(once) : once;
            } catch {
                guestFrames = [];
            }
            const viewports = [...new Set(guestFrames.map(([, w, h, dpr]) => `${String(w)}x${String(h)}@${String(dpr)}`))];
            /*
             * THE ROUND-3 ASSERTION. A menu is not a resize: the pane's rect never changed, so the
             * page must not have been re-laid-out at all. Before the fix the park re-pinned it to the
             * automation viewport and this run reported two viewports — `525x706@2` and `1280x800@1`
             * — with the second one still on screen for hundreds of milliseconds after the menu
             * closed, clipped into a pane less than half its width.
             */
            // Only the idle pass can answer this: a busy page starves its own sampler.
            if (!busy) passCheck(
                'the page is never re-laid-out for a menu (one viewport for the whole gesture)',
                guestFrames.length > 0 && viewports.length === 1,
                `${String(guestFrames.length)} page frames, viewports: ${viewports.join(' → ') || '(none sampled)'}`
            );
                lastGuest = guestFrames;
            fs.writeFileSync(path.join(outDir, `guest-${label}.json`), JSON.stringify(guestFrames));


        };
        await pass('idle', false);
        await pass('busy', true);
        clearInterval(pump);

        const timeline = [
            ...lastSampled.frames.map((frame) => ({
                at: frame.at,
                text: `frame  visible=${String(frame.visible)} covered=${String(frame.covered)} ` +
                    (frame.poster === null
                        ? 'poster=-'
                        : `poster=${String(frame.poster.naturalW)}×${String(frame.poster.naturalH)} ` +
                          `box=${String(frame.poster.x)},${String(frame.poster.y)} ${String(frame.poster.w)}×${String(frame.poster.h)}`)
            })),
            ...stamps.map((stamp) => ({ at: stamp.at, text: `shell  ${stamp.line}` })),
            ...lastGuest.map(([at, w, h, dpr]) => ({
                at,
                text: `page   ${String(w)}x${String(h)} @${String(dpr)}`
            })),
            ...lastSampled.marks.map((mark) => ({ at: mark.at, text: `──     ${mark.name}` }))
        ].sort((a, b) => a.at - b.at);
        const origin = timeline[0]?.at ?? 0;
        fs.writeFileSync(
            path.join(outDir, 'timeline.txt'),
            timeline.map((entry) => `${String(entry.at - origin).padStart(6)}ms ${entry.text}`).join('\n')
        );
        log(`\n  timeline: ${path.join(outDir, 'timeline.txt')}`);
    } finally {
        try {
            page?.close();
        } catch {
            // already gone
        }
        shell?.child.kill('SIGTERM');
        daemon.child.kill('SIGTERM');
        site.server.close();
        await sleep(400);
        if (!options.keep && options.out === null) fs.rmSync(outDir, { recursive: true, force: true });
    }

    const failed = results.filter((result) => !result.ok);
    log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`);
    process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
