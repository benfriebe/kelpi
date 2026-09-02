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
    window: valued('--window', 'hidden'),
    out: valued('--out', null)
};

const { buildAll, makeSandbox, startDaemon, startShell, waitForHealthz, makeCli, waitFor, sleep } = await import(
    path.join(repoRoot, 'scripts', 'ui-audit', 'lib', 'stack.mjs')
);
const { waitForPageTarget, connect } = await import(path.join(repoRoot, 'scripts', 'ui-audit', 'lib', 'cdp.mjs'));

const results = [];
const log = (line) => process.stdout.write(`${line}\n`);
function check(name, ok, detail = '') {
    results.push({ name, ok });
    log(`  ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : `  ${detail}`}`);
}

/**
 * The fixture: 24 px bands in a rotating hue with their row number in them. A vertical shift of
 * one pixel changes which band a given image row falls in, so a jump is legible in a still.
 */
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Poster Swap Fixture</title>
<style>html,body{margin:0;padding:0;background:#101014;color:#fff;font:12px/24px ui-monospace,monospace}
.row{height:24px;padding-left:8px}</style></head><body><div id="rows"></div>
<script>
  const rows = document.getElementById('rows');
  for (let i = 0; i < 200; i++) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.background = 'hsl(' + ((i * 37) % 360) + ',70%,' + (18 + (i % 5) * 6) + '%)';
    row.textContent = 'row ' + i;
    rows.appendChild(row);
  }
</script></body></html>`;

async function main() {
    const outDir = options.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-poster-swap-'));
    fs.mkdirSync(outDir, { recursive: true });

    if (options.build) {
        log('building the tree (skip with --no-build)…');
        await buildAll(repoRoot, { log: (line) => log(`  ${line}`) });
    }
    const clientDir = path.join(repoRoot, 'packages', 'client', 'dist');
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
    const daemon = startDaemon(sandbox, { repoRoot, verbose: options.verbose });
    let shell = null;
    let page = null;
    try {
        await waitForHealthz(sandbox.base);
        const cli = makeCli(sandbox, { repoRoot });
        shell = startShell(sandbox, {
            repoRoot,
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

        const target = await waitForPageTarget(sandbox.debugPort, { match: (t) => t.url.includes('shellWindow=') });
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
        // The page has painted and the layout has settled, so the "before" frames are steady.
        await sleep(1500);

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

        await sleep(300);
        await page.eval(`window.__posterMark('open')`);
        await page.rightClick(`[data-testid="pane-header-${paneID}"]`);
        await waitFor(
            'the menu to be up',
            async () => (await page.eval(`document.querySelector('[data-testid="context-menu"]') !== null`)) === true,
            10_000
        );
        await sleep(900);
        await page.eval(`window.__posterMark('close')`);
        await page.key('Escape');
        await sleep(900);

        clearInterval(pump);
        const probe = await page.eval(`JSON.stringify(window.__posterProbe)`);
        const sampled = JSON.parse(String(probe));
        fs.writeFileSync(path.join(outDir, 'frames.json'), JSON.stringify(sampled, null, 2));
        fs.writeFileSync(path.join(outDir, 'shell.log'), shell.text());

        // ── the two clocks, merged ──────────────────────────────────────────────────
        const parked = stamps.find((stamp) => stamp.line.includes('owner=holder'));
        const restored = stamps.find(
            (stamp) => stamp.line.includes('owner=main') && parked !== undefined && stamp.at > parked.at
        );
        const placement = [...stamps]
            .reverse()
            .find((stamp) => /owner=main bounds=(\d+),(\d+) (\d+)×(\d+)/.test(stamp.line));
        check('the shell parked the view for the menu', parked !== undefined, parked?.line ?? '(no owner=holder line)');
        check('…and handed it back when the menu closed', restored !== undefined, restored?.line ?? '(no restore)');
        if (parked === undefined || restored === undefined || placement === undefined) {
            throw new Error('the swap did not happen; nothing to measure');
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
        check(
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
        check(
            'no frame between park and restore shows an empty hole',
            between.length > 0 && blanks.length === 0,
            `${String(between.length - blanks.length)}/${String(between.length)} frames carried the picture`
        );

        // 3 — it stands exactly where the view stood.
        const boxes = [...new Set(between.filter(withPoster).map((frame) => `${frame.poster.x},${frame.poster.y} ${frame.poster.w}×${frame.poster.h}`))];
        const sample = between.find(withPoster);
        check(
            'the picture stands exactly on the box the shell placed the view at',
            sample !== undefined &&
                sample.poster.x === bounds.x &&
                sample.poster.y === bounds.y &&
                sample.poster.w === bounds.w &&
                sample.poster.h === bounds.h,
            `poster ${boxes.join(' | ')} vs view ${String(bounds.x)},${String(bounds.y)} ${String(bounds.w)}×${String(bounds.h)}`
        );

        // 4 — 1:1 in device pixels, so it is the page rather than a resampled copy of it.
        check(
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
        check(
            'the picture is still there for the frames after the view comes back',
            afterRestore.length > 0 && afterRestore.every(withPoster),
            `${String(afterRestore.filter(withPoster).length)}/${String(afterRestore.length)} frames`
        );

        // …and eventually goes, or the pane would keep a stale photograph for ever.
        const lastFrames = frames.slice(-3);
        check(
            'and it is gone once the live view has had time to paint',
            lastFrames.length > 0 && lastFrames.every((frame) => frame.poster === null),
            `${String(lastFrames.filter((frame) => frame.poster === null).length)}/${String(lastFrames.length)} final frames`
        );

        const timeline = [
            ...frames.map((frame) => ({
                at: frame.at,
                text: `frame  visible=${String(frame.visible)} covered=${String(frame.covered)} ` +
                    (frame.poster === null
                        ? 'poster=-'
                        : `poster=${String(frame.poster.naturalW)}×${String(frame.poster.naturalH)} ` +
                          `box=${String(frame.poster.x)},${String(frame.poster.y)} ${String(frame.poster.w)}×${String(frame.poster.h)}`)
            })),
            ...stamps.map((stamp) => ({ at: stamp.at, text: `shell  ${stamp.line}` })),
            ...sampled.marks.map((mark) => ({ at: mark.at, text: `──     ${mark.name}` }))
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
