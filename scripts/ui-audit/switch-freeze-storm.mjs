#!/usr/bin/env node
/**
 * Issue #78's live harness: does switching workspaces stop the app answering?
 *
 * The issue is a main-thread question, and the only honest instrument for a wedged main thread
 * is one that lives OUTSIDE it. `resize-flash-storm.mjs` (§N24) reads the engine's cells from
 * Node because a screenshot cannot see what a canvas composited mid-gesture; this reads the
 * CLOCK from Node, every 50 ms, for the same reason: a page that is parsing a multi-megabyte
 * snapshot inside one synchronous WASM call answers nothing at all, and no assertion evaluated
 * INSIDE that page can observe its own silence.
 *
 * The stack is the driver's (`lib/driver.mjs boot`): a private sandbox daemon, a real Electron
 * shell, a real ghostty-web client, the real CLI. Nothing is simulated and nothing is stubbed.
 *
 * THE SETUP (the issue's own repro, and what it took to make it bite)
 *   two workspaces, `--panes` shell panes each (8), each filled with a long line repeated,
 *   plus one web pane per workspace. The daemon keeps 10 000 lines of scrollback per pane
 *   (`daemon/src/term/service.ts` DEFAULT_SCROLLBACK_LINES), so what each pane owes an
 *   attaching client is a full 10 000-row snapshot, and a workspace switch mounts every one of
 *   them at once. `--fill` decides how heavy that snapshot is, and it is the difference between
 *   a hitch and a freeze: see the note above the modes (the issue's own `yes | head -300000` is
 *   0.52 MB a pane; `--fill dense`, a resumed agent session's shape, is 6.94 MB).
 *
 *   The fill runs while the pane's workspace is NOT active: the client is not attached, so the
 *   18 MB goes into the daemon's VT alone rather than through the client's live path. That is
 *   deliberate. The thing under test is the MOUNT flush, and seeding through a live attach
 *   would spend twenty minutes proving the flow-control path instead.
 *
 * PROBE A: responsiveness (the freeze itself)
 *   A `Runtime.evaluate('Date.now()')` every 50 ms from Node, its wall-clock round trip
 *   recorded. Twenty alternating switches at `--interval` (300 ms), half through the sidebar
 *   row (a real click at real coordinates), half through ⌘1/⌘2. Pass: p95 < 150 ms and
 *   max < 500 ms across each switch and the 3 s behind it. Fail: any round trip over 1000 ms.
 *
 * PROBE B: clicks land
 *   After each switch of the second phase, click the centre of a known pane header of the
 *   incoming workspace and require `data-focused="true"` within 500 ms. 20 of 20.
 *
 * PROBE C: native occlusion (what discriminates this from #72)
 *   The shell logs `web pane <id> view owner=main|holder bounds=…` (`shell/src/webhost/index.ts`).
 *   After each switch settles, exactly the incoming workspace's web pane may be `owner=main`.
 *   A freeze that is really a swallowed-input leak shows up here; a freeze that is really a
 *   blocked main thread does not.
 *
 * `--bench`: THE SAME DEFECT AT THE SEAM, and the one that separates the trees
 *   The three probes above are the product question, and on a fast machine they answer "yes,
 *   it is answering" on BOTH trees: the mount queue only carries a snapshot when the replay
 *   beats the engine, and a warm `ghostty-web` (its module imported, its WASM instantiated)
 *   usually wins that race by a whole daemon round trip. So `--bench` asks the mechanism
 *   directly, with no Electron: the real adapter (`renderer.ts`, transpiled by esbuild, never
 *   re-implemented, exactly as `resize-flash-storm.mjs` does it), the real `ingest.ts`, the
 *   real ghostty WASM VT, N panes each handed a 7 MB serialized snapshot BEFORE `open()`, and a
 *   1 ms heartbeat on the event loop whose longest GAP is the length of the freeze.
 *
 *   Measured on this tree, 7 MB per pane (M-series, `--window hidden`, other agents working):
 *
 *     panes  shipped: longest gap        with the budget
 *       8    474 ms (2839 ms under load) 68 ms
 *      12    697 ms                      100 ms
 *
 *   The shipped number is ONE uninterrupted block: 31.5 MB parsed in 512 back-to-back writes
 *   with nothing between them, which is why the flow-control acks stall and the daemon re-seeds.
 *
 * WHAT THE LIVE PROBES FOUND, so the next reader does not re-derive it
 *   At 8 and 12 panes with 7 MB replays, neither tree freezes through the app: the worst round
 *   trip is ~110 ms, on the FIRST switch, and it is the same before and after. Probe C is the
 *   one that goes red on the shipped tree (2 to 6 switches of 20 leave the incoming workspace's
 *   web pane in the holder), and that is #72's leak rather than this issue's parse: it is
 *   reported here because probe C is what tells the two apart.
 *
 * Usage:
 *
 *     node scripts/ui-audit/switch-freeze-storm.mjs [--no-build] [--window hidden|offscreen|onscreen]
 *          [--panes 8] [--fill dense|colour|plain] [--lines N] [--switches 20] [--interval 300]
 *          [--out <dir>] [--keep] [--verbose]
 *     node scripts/ui-audit/switch-freeze-storm.mjs --bench [--panes 8] [--bench-bytes 7340032]
 *
 * `--window hidden` is the default and it is what makes this safe to run while somebody else is
 * using the machine: same window, same bounds, zero opacity (`scripts/ui-audit/README.md`). It
 * costs the screenshots, which this harness does not take, and nothing else: every number here
 * is a CDP round trip, a DOM attribute or a shell log line. `--bench` needs no window at all.
 *
 * Writes `timeline.json` (every sample and every event, stamped) and `summary.json` beside it,
 * or `bench.json` under `--bench`. Exit code 0 = every probe passed.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const require = createRequire(path.join(repoRoot, 'packages', 'shell', 'package.json'));
const WebSocket = require('ws');

const { boot, sleep, settle, MOD } = await import(path.join(here, 'lib', 'driver.mjs'));

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valued = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const options = {
    bench: has('--bench'),
    benchBytes: Number(valued('--bench-bytes', String(7 * 1024 * 1024))),
    build: !has('--no-build'),
    keep: has('--keep'),
    verbose: has('--verbose'),
    window: valued('--window', 'hidden'),
    fill: valued('--fill', 'dense'),
    panes: Number(valued('--panes', '8')),
    lines: Number(valued('--lines', '300000')),
    switches: Number(valued('--switches', '20')),
    intervalMs: Number(valued('--interval', '300')),
    sampleMs: Number(valued('--sample', '50')),
    // Absolute: `--bench` imports a bundle it writes in here, and an import needs a real path.
    out: path.resolve(valued('--out', path.join(repoRoot, 'docs', 'audit', 'switch-freeze', stamp)))
};

/*
 * `--lines` counts SOURCE lines, and a dense line is ~240 coloured cells: five wrapped rows of
 * it in a pane this narrow, ~3 KB each. 6 000 of them overfill the daemon's 10 000-row retention
 * three times over, which is all that can matter: anything beyond it is parse time the daemon
 * spends during setup for a snapshot that is already at its ceiling. The plain and colour modes
 * keep the issue's own 300 000, where a line is one row.
 */
if (!argv.includes('--lines')) options.lines = options.fill === 'dense' ? 6_000 : 300_000;

/** Probe A's thresholds, from the issue. */
const P95_BUDGET_MS = 150;
const MAX_BUDGET_MS = 500;
const FREEZE_MS = 1_000;
/** How long after a switch the app still has to be answering. */
const SETTLE_WINDOW_MS = 3_000;
/** Probe B's ceiling: a click that has not landed inside this is a click the user lost. */
const CLICK_BUDGET_MS = 500;

const log = (line) => process.stdout.write(`${line}\n`);
const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok: ok === true, detail: String(detail) });
    log(`  ${ok === true ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : `  ${String(detail)}`}`);
    return ok === true;
}

const percentile = (values, p) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index];
};

/** Something with a heartbeat, so a web pane that is alive is legible in the shell's log. */
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Switch Freeze Fixture</title>
<style>html,body{margin:0;background:#101014;color:#7ee787;font:24px/1.4 ui-monospace,monospace}
#t{padding:20px}</style></head><body><div id="t">starting…</div>
<script>let n=0;setInterval(()=>{n+=1;document.getElementById('t').textContent='tick '+n;},100);</script>
</body></html>`;

/**
 * `--bench`: the same defect, measured at the SEAM instead of through the app.
 *
 * The live probes below are the product question ("is the app answering?"), and on a fast
 * machine they answer yes on both trees, because the mount queue only carries a snapshot when
 * the replay BEATS the engine and a warm `ghostty-web` usually wins that race. The mechanism is
 * still there, and this is the instrument for it: the real adapter (`renderer.ts`, transpiled,
 * not re-implemented, exactly as `resize-flash-storm.mjs` does it), the real `ingest.ts`, the
 * real ghostty WASM VT, a real multi-megabyte snapshot queued before `open()`, and a 1 ms
 * heartbeat on the event loop, whose longest GAP is the length of the freeze.
 *
 * That gap is the number the issue is about: one synchronous parse of the whole queue, N panes
 * in a row, versus 8 ms slices with the loop free between them.
 */
async function bench() {
    // ghostty-web's dist reaches for `self` while loading its inlined wasm.
    globalThis.self = globalThis;
    const esbuildPath = require.resolve('esbuild', { paths: [repoRoot, path.join(repoRoot, 'packages', 'shell')] });
    const esbuild = require(esbuildPath);
    const bundle = path.join(options.out, `renderer-${String(process.pid)}.mjs`);
    fs.mkdirSync(options.out, { recursive: true });
    await esbuild.build({
        entryPoints: [path.join(repoRoot, 'packages', 'client', 'src', 'terminal', 'renderer.ts')],
        outfile: bundle,
        bundle: true,
        format: 'esm',
        platform: 'neutral',
        target: 'es2022',
        external: ['ghostty-web', '@xterm/xterm'],
        plugins: [
            {
                name: 'stub-fonts',
                setup(build) {
                    build.onResolve({ filter: /\.\/fonts$/ }, () => ({ path: 'kelpi-fonts-stub', namespace: 'stub' }));
                    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
                        contents:
                            'export const TERMINAL_FONT_FALLBACKS = "monospace";' +
                            'export const loadTerminalFonts = async () => undefined;' +
                            'export const measureCellSize = () => ({ width: 8, height: 17 });',
                        loader: 'js'
                    }));
                }
            }
        ]
    });
    const { createRendererFromLoader, PENDING_WRITE_LIMIT_BYTES } = await import(bundle);
    const { createTerminalIngest } = await import(path.join(repoRoot, 'packages', 'client', 'src', 'terminal', 'ingest.ts'));
    const { Ghostty } = await import(path.join(repoRoot, 'vendor', 'ghostty-web-patched', 'dist', 'ghostty-web.js'));
    const ghostty = await Ghostty.load();

    const COLS = 52;
    const ROWS = 24;
    /** A serialized row the way the daemon's serializer writes one: an SGR run per cell. */
    const row = Array.from({ length: COLS }, (_, i) => `\u001b[38;5;${String(16 + (i % 216))}m${'abcdefghijklmnopqrstuvwxyz0123456789'[i % 36]}`).join('');
    let snapshot = '';
    while (snapshot.length < options.benchBytes) snapshot += `${row}\u001b[0m\r\n`;

    /** An `EngineHandle` over the raw WASM terminal, as `resize-flash-storm.mjs` builds one. */
    const handles = [];
    const makeHandle = () => {
        const wasmTerm = ghostty.createTerminal(COLS, ROWS);
        const writes = [];
        const terminal = {
            get cols() {
                return wasmTerm.getDimensions().cols;
            },
            get rows() {
                return wasmTerm.getDimensions().rows;
            },
            open() {},
            write(data) {
                const at = performance.now();
                wasmTerm.write(data);
                writes.push({ bytes: data.length, ms: performance.now() - at });
            },
            reset() {
                wasmTerm.write('\u001bc');
            },
            focus() {},
            blur() {},
            resize(cols, rows) {
                wasmTerm.resize(cols, rows);
            },
            dispose() {
                try {
                    wasmTerm.free();
                } catch {
                    /* already gone */
                }
            },
            onData() {
                return { dispose() {} };
            }
        };
        const handle = { terminal, wasmTerm, writes };
        handles.push(handle);
        return handle;
    };

    log(`bench: ${String(options.panes)} panes, ${(snapshot.length / 1_048_576).toFixed(2)} MB of serialized snapshot each, ` +
        `queued before open() (the adapter's cap is ${(PENDING_WRITE_LIMIT_BYTES / 1_048_576).toFixed(2)} MB)`);

    // Queue every pane's replay through the REAL ingest, into renderers whose engines are not
    // open yet: precisely what a mount does when the daemon answers before the WASM is up.
    const panes = [];
    for (let i = 0; i < options.panes; i += 1) {
        const handle = makeHandle();
        const renderer = createRendererFromLoader('ghostty', async () => handle, { cols: COLS, rows: ROWS });
        const ingest = createTerminalIngest(renderer);
        ingest.replay(snapshot);
        panes.push({ handle, renderer, ingest });
    }
    // ingest chunks under its own 8 ms budget, so let it finish handing the queue over.
    await sleep(1_000);

    // The heartbeat. Its longest gap IS the longest time the loop was not free to run anything
    // else: a socket handler, a flow-control ack, a paint, a click.
    const gaps = [];
    let last = performance.now();
    const heartbeat = setInterval(() => {
        const now = performance.now();
        gaps.push(now - last);
        last = now;
    }, 1);
    const started = performance.now();
    await Promise.all(panes.map((pane) => pane.renderer.open({})));
    const openedAt = performance.now();
    // Drained when the loop has been quiet for 500 ms.
    let quiet = 0;
    while (quiet < 500) {
        const before = gaps.length;
        await sleep(50);
        const recent = gaps.slice(before);
        quiet = recent.every((gap) => gap < 20) ? quiet + 50 : 0;
    }
    clearInterval(heartbeat);

    const worst = Math.max(0, ...gaps);
    const over = (ms) => gaps.filter((gap) => gap > ms).length;
    const perPane = handles.map((handle) => ({
        writes: handle.writes.length,
        bytes: handle.writes.reduce((sum, entry) => sum + entry.bytes, 0),
        parseMs: Number(handle.writes.reduce((sum, entry) => sum + entry.ms, 0).toFixed(1))
    }));
    const totals = perPane.reduce(
        (sum, entry) => ({ writes: sum.writes + entry.writes, bytes: sum.bytes + entry.bytes, parseMs: sum.parseMs + entry.parseMs }),
        { writes: 0, bytes: 0, parseMs: 0 }
    );

    log('');
    log(`  longest event-loop gap    ${worst.toFixed(1)} ms   <- the freeze, measured`);
    log(`  gaps over 100 / 250 / 500 ms  ${String(over(100))} / ${String(over(250))} / ${String(over(500))}`);
    log(`  open() resolved after     ${(openedAt - started).toFixed(1)} ms (the startup gate's own hold)`);
    log(`  drained in                ${(performance.now() - started).toFixed(1)} ms of wall clock`);
    log(`  written into the engines  ${(totals.bytes / 1_048_576).toFixed(2)} MB in ${String(totals.writes)} writes, ` +
        `${totals.parseMs.toFixed(0)} ms of WASM parse`);
    log(`  per pane                  ${perPane.map((entry) => `${(entry.bytes / 1_048_576).toFixed(2)} MB/${String(entry.writes)}w`).join(' · ')}`);

    log('');
    check(
        `mounting ${String(options.panes)} panes never blocks the loop for ${String(FREEZE_MS)} ms`,
        worst < FREEZE_MS,
        `longest gap ${worst.toFixed(0)} ms${worst < FREEZE_MS ? '' : ' - ISSUE #78: nothing runs in that window, including the flow-control acks'}`
    );
    check(
        `and never for more than ${String(MAX_BUDGET_MS)} ms, so a click in that window is still answered`,
        worst < MAX_BUDGET_MS,
        `longest gap ${worst.toFixed(0)} ms`
    );

    fs.writeFileSync(
        path.join(options.out, 'bench.json'),
        `${JSON.stringify(
            {
                options,
                worstGapMs: worst,
                gapsOver: { 100: over(100), 250: over(250), 500: over(500) },
                openMs: openedAt - started,
                drainedMs: performance.now() - started,
                perPane,
                totals,
                checks: results
            },
            null,
            2
        )}\n`
    );
    log(`  written to ${path.join(options.out, 'bench.json')}`);
    for (const pane of panes) pane.renderer.dispose();
    fs.rmSync(bundle, { force: true });
    const failed = results.filter((entry) => !entry.ok);
    log('');
    log(`${String(results.length - failed.length)}/${String(results.length)} probes passed`);
    process.exitCode = failed.length === 0 ? 0 : 1;
}

async function main() {
    if (options.bench) return await bench();
    fs.mkdirSync(options.out, { recursive: true });
    log(`switch-freeze-storm · ${options.panes} panes/workspace · ${options.lines} ${options.fill} lines/pane · ` +
        `${options.switches} switches at ${options.intervalMs} ms · window ${options.window}`);
    log(`  out ${options.out}`);

    const site = await new Promise((resolve) => {
        const server = http.createServer((_request, response) => {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.end(FIXTURE);
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
    });

    const t = await boot({
        repoRoot,
        label: 'switch-freeze',
        build: options.build,
        window: options.window,
        log: (line) => log(`  ${line}`)
    });
    const { page, cli, shell } = t;
    /** `driver.boot`'s cli has `run` and `ok`; this is the third form the setup wants. */
    const json = async (args, opts = {}) => JSON.parse(await cli.ok(args, opts));

    /** Every sample and every event, stamped against one clock. */
    const timeline = { started: Date.now(), samples: [], events: [], placements: [] };
    const event = (kind, detail = {}) => {
        const entry = { at: Date.now(), kind, ...detail };
        timeline.events.push(entry);
        if (options.verbose) log(`    · ${kind} ${JSON.stringify(detail)}`);
        return entry;
    };

    // The shell's placement lines, stamped as they arrive: probe C's whole instrument.
    let consumed = 0;
    const pump = setInterval(() => {
        while (consumed < shell.lines.length) {
            const line = shell.lines[consumed];
            consumed += 1;
            const match = /web pane ([0-9A-Fa-f-]{36}) view owner=(main|holder) bounds=(\S+ \S+|-) \(([^)]*)\)/.exec(line);
            if (match === null) continue;
            timeline.placements.push({ at: Date.now(), paneID: match[1].toUpperCase(), owner: match[2], bounds: match[3], reason: match[4] });
        }
    }, 5);
    pump.unref?.();
    const ownerOf = (paneID) =>
        timeline.placements.filter((entry) => entry.paneID === paneID.toUpperCase()).at(-1) ?? null;

    // ── probe A's sampler ───────────────────────────────────────────────────────────
    //
    // Fired, not awaited: a wedged renderer must be allowed to leave N of these outstanding, and
    // each one measures from its OWN send, so the depth of the queue is the depth of the freeze.
    let sampling = false;
    let phase = 'idle';
    const sample = () => {
        if (!sampling) return;
        const sent = Date.now();
        const entry = { at: sent, phase, rtt: null };
        timeline.samples.push(entry);
        page.send('Runtime.evaluate', { expression: 'Date.now()', returnByValue: true }, 60_000).then(
            () => {
                entry.rtt = Date.now() - sent;
            },
            (error) => {
                entry.rtt = Date.now() - sent;
                entry.error = String(error?.message ?? error);
            }
        );
    };
    const sampler = setInterval(sample, options.sampleMs);
    sampler.unref?.();

    let exitCode = 0;
    try {
        // ── setup ───────────────────────────────────────────────────────────────────
        const setupStart = Date.now();
        const workspaces = [
            { name: 'Alpha', digit: null, panes: [], web: null },
            { name: 'Beta', digit: null, panes: [], web: null }
        ];

        for (const workspace of workspaces) {
            await cli.ok(['workspace', 'create', '--name', workspace.name]);
            await settle(async () =>
                (await page.eval(
                    `(document.querySelector('[data-testid="workspace-row"][data-active="true"]')?.textContent ?? '')
                        .includes(${JSON.stringify(workspace.name)})`
                )) === true, { ceilingMs: 30_000 });
            // A balanced tree: split every pane once per round, alternating direction.
            const ids = (await json(['pane', 'list', '--workspace', workspace.name, '--json'])).map((pane) => pane.id);
            for (let round = 0; ids.length < options.panes; round += 1) {
                const direction = round % 2 === 0 ? 'vertical' : 'horizontal';
                for (const target of [...ids]) {
                    if (ids.length >= options.panes) break;
                    const split = await json(['pane', 'split', '--target', target, '--direction', direction, '--json']);
                    ids.push(String(split.pane_id));
                }
            }
            workspace.panes = ids;
            const opened = await cli.ok(['web', 'open', site.url], { timeoutMs: 60_000 });
            const webID = (/open ok:\s*([0-9a-f-]{36})/i.exec(opened) ?? [])[1];
            if (webID === undefined) throw new Error(`no web pane opened in ${workspace.name}: ${opened}`);
            workspace.web = webID;
            log(`  ${workspace.name}: ${String(ids.length)} shell panes + web ${webID.slice(0, 8)}`);
        }

        /*
         * ⌘1…⌘9 is 0-based over the SIDEBAR's visible order (`App.tsx switchToIndex`), and the
         * sandbox already has a workspace before these two are made: so the chord for `Alpha`
         * is read off the rows rather than assumed to be ⌘1.
         */
        const rows = JSON.parse(String(await page.eval(
            `JSON.stringify(Array.from(document.querySelectorAll('[data-testid="workspace-row"]')).map(el => (el.textContent ?? '').trim()))`
        )));
        for (const workspace of workspaces) {
            const index = rows.findIndex((label) => label.includes(workspace.name));
            if (index < 0 || index > 8) throw new Error(`${workspace.name} is not in the sidebar's first nine rows: ${JSON.stringify(rows)}`);
            workspace.position = index + 1;
            workspace.digit = `Digit${String(index + 1)}`;
        }
        log(`  sidebar order ${JSON.stringify(rows)} → Alpha=⌘${String(workspaces[0].position)} Beta=⌘${String(workspaces[1].position)}`);

        /*
         * What the scrollback is filled WITH, and why the default is not the issue's own line.
         *
         * The daemon keeps 10 000 ROWS per pane, so the payload a mounting pane owes is not
         * "how many lines were printed": it is those rows SERIALIZED, and a serialized row
         * costs one SGR sequence per attribute run. That is the whole difference between the
         * three modes, measured on this tree at eight panes:
         *
         *   `--fill plain`  the issue's line, literally (`yes '<long line>' | head -N`):
         *                   0.52 MB per pane, 4.2 MB per workspace. Does NOT reproduce.
         *   `--fill colour` six SGR runs per line: 0.83 MB per pane, 6.6 MB. Does not either.
         *   `--fill dense`  (default) one colour per CELL, which is what a resumed agent
         *                   session's transcript looks like to a serializer: the issue's own
         *                   "or a resumed agent session", and the shape of the 8.8 MB session
         *                   `ingest.ts:19-32` was written for.
         *
         * The control numbers for all three belong in the PR: "the plain repro is only a hitch
         * on this machine, and here is what it took to make it a freeze" is a finding, not a
         * failure to reproduce.
         */
        const FILLS = {
            plain: `yes 'some long line of text to make the scrollback heavy' | head -${String(options.lines)}`,
            colour:
                `yes "$(printf '\\033[31mred \\033[1;32mgreen \\033[33myellow \\033[4;34mblue \\033[35mmagenta ` +
                `\\033[7;36mcyan \\033[0msome long line of text to make the scrollback heavy')" | head -${String(options.lines)}`,
            dense:
                `KELPIDENSE=$(awk 'BEGIN{s="abcdefghijklmnopqrstuvwxyz0123456789";` +
                `for(i=0;i<240;i++){printf "\\033[38;5;%dm%s", 16+(i%216), substr(s,(i%36)+1,1)}printf "\\033[0m"}'); ` +
                `yes "$KELPIDENSE" | head -${String(options.lines)}`
        };
        if (FILLS[options.fill] === undefined) throw new Error(`unknown --fill ${String(options.fill)} (want ${Object.keys(FILLS).join(' | ')})`);
        const FILL = `${FILLS[options.fill]}; printf 'KELPIFILLDONE\\n'`;
        for (const workspace of workspaces) {
            const other = workspaces.find((entry) => entry !== workspace);
            await activate(page, other.name);
            await sleep(500);
            log(`  filling ${workspace.name}'s ${String(workspace.panes.length)} panes (${String(options.lines)} lines each)…`);
            for (const paneID of workspace.panes) await cli.ok(['pane', 'send', '--target', paneID, FILL]);
            for (const paneID of workspace.panes) {
                const done = await settle(
                    async () => (await cli.run(['pane', 'capture', '--target', paneID])).stdout.includes('KELPIFILLDONE'),
                    { ceilingMs: 300_000, intervalMs: 500 }
                );
                if (!done) throw new Error(`pane ${paneID} never finished filling`);
            }
        }
        // What one pane's snapshot actually weighs, for the record: this is the payload the
        // mount flush parses, per pane, on every switch.
        const measured = (await cli.run(['pane', 'capture', '--target', workspaces[0].panes[0], '--scrollback'])).stdout;
        const historyBytes = Buffer.byteLength(measured, 'utf8');
        const replayBytes = await measureReplays(t.sandbox, workspaces[0].panes, { cols: 80, rows: 24 });
        const replayTotal = replayBytes.reduce((sum, value) => sum + value, 0);
        log(`  history per pane: ${String(historyBytes)} bytes of text in the daemon's VT ` +
            `(${String(measured.split('\n').length)} lines), setup took ${((Date.now() - setupStart) / 1000).toFixed(1)} s`);
        log(`  replay per pane: ${replayBytes.map((value) => `${(value / 1_048_576).toFixed(2)} MB`).join(' · ')} ` +
            `(${(replayTotal / 1_048_576).toFixed(1)} MB for one workspace's mount)`);

        await activate(page, workspaces[0].name);
        await sleep(2_000);

        // ── phase 1: the storm ──────────────────────────────────────────────────────
        const rtts = (name) =>
            timeline.samples.filter((entry) => entry.phase === name && entry.rtt !== null).map((entry) => entry.rtt);
        sampling = true;
        phase = 'baseline';
        await sleep(1_500);
        const baseline = rtts('baseline');
        log(`  baseline round trip: p50 ${String(percentile(baseline, 50))} ms · p95 ${String(percentile(baseline, 95))} ms · ` +
            `max ${String(Math.max(0, ...baseline))} ms`);

        /*
         * ── phase 1a: the window rebuilds the heavy workspace ───────────────────────
         *
         * The mount flush only carries anything when the REPLAY BEATS THE ENGINE, and on a
         * warm page it usually loses: `ghostty-web`'s module and its WASM are already
         * instantiated, so `open()` resolves in a microtask while the daemon is still
         * serializing a multi-megabyte snapshot. A reload is the case where the engine is
         * genuinely slow: a fresh page instantiates the WASM once, so every pane's replay
         * lands in `AdapterRenderer`'s queue and comes out of it at `open()`. Same code path
         * the workspace switch takes, entered the way it is actually entered in the wild:
         * launch, relaunch, a window rebuilt after a close, a reconnect that re-seeds.
         */
        phase = 'reload';
        // Stamped BEFORE the reload and gone after it: `Page.reload` returns as soon as the
        // command is accepted, so "are the headers back" against the old document answers yes
        // immediately and measures nothing.
        await page.eval('window.__kelpiPreReload = 1');
        const reloadAt = Date.now();
        event('reload', { workspace: workspaces[0].name });
        await page.send('Page.reload', {}, 60_000);
        const rebuilt = await settle(
            async () => {
                try {
                    // LIVE, not merely present: the headers are back within a frame of the
                    // reload, and the window under test is the one where every engine comes up
                    // and swallows the replay that was waiting for it.
                    return (
                        (await page.eval(
                            `window.__kelpiPreReload === undefined &&` +
                                ` document.querySelectorAll('[data-terminal-status="live"]').length >= ${String(options.panes)}`
                        )) === true
                    );
                } catch {
                    return false;
                }
            },
            { ceilingMs: 120_000, intervalMs: 100 }
        );
        const reloadReadyAt = Date.now();
        await sleep(SETTLE_WINDOW_MS);
        const reloadValues = window(timeline.samples, reloadAt, reloadReadyAt + SETTLE_WINDOW_MS).map((entry) => entry.rtt);
        log(`  reload: the grid was back in ${((reloadReadyAt - reloadAt) / 1000).toFixed(1)} s` +
            `${rebuilt ? '' : ' (TIMED OUT waiting for the headers)'} · ` +
            `p50 ${String(percentile(reloadValues, 50))} · p95 ${String(percentile(reloadValues, 95))} · ` +
            `max ${String(Math.max(0, ...reloadValues))} ms`);
        await sleep(1_000);

        phase = 'storm';
        const stormSwitches = [];
        for (let i = 0; i < options.switches; i += 1) {
            const incoming = workspaces[(i + 1) % workspaces.length];
            const via = i % 2 === 0 ? 'sidebar' : 'chord';
            const at = Date.now();
            if (via === 'sidebar') await clickWorkspaceRow(page, incoming.name);
            else await page.key(incoming.digit, { modifiers: MOD.meta, key: String(incoming.position), keyCode: 48 + incoming.position });
            stormSwitches.push({ index: i + 1, at, via, workspace: incoming.name });
            event('switch', { phase: 'storm', index: i + 1, via, workspace: incoming.name });
            await sleep(options.intervalMs);
        }
        const stormEnd = Date.now();
        await sleep(SETTLE_WINDOW_MS);
        phase = 'settled';
        await sleep(500);

        // ── phase 2: the same switches, with a click after each one ─────────────────
        phase = 'clicks';
        const clickResults = [];
        const occlusion = [];
        for (let i = 0; i < options.switches; i += 1) {
            // The storm ended on `workspaces[0]`, so this one starts by leaving it.
            const incoming = workspaces[(i + 1) % workspaces.length];
            const outgoing = workspaces[i % workspaces.length];
            const via = i % 2 === 0 ? 'sidebar' : 'chord';
            const at = Date.now();
            if (via === 'sidebar') await clickWorkspaceRow(page, incoming.name);
            else await page.key(incoming.digit, { modifiers: MOD.meta, key: String(incoming.position), keyCode: 48 + incoming.position });
            event('switch', { phase: 'clicks', index: i + 1, via, workspace: incoming.name });

            // Probe B: a header of the INCOMING workspace, clicked where a person clicks.
            const target = incoming.panes[i % incoming.panes.length];
            const selector = `[data-testid="pane-header-${target}"]`;
            const appeared = await settle(async () => (await page.box(selector)) !== null, { ceilingMs: 5_000, intervalMs: 25 });
            let landedMs = null;
            if (appeared) {
                const box = await page.box(selector);
                const clickedAt = Date.now();
                await page.clickAt(box.cx, box.cy);
                const flipped = await settle(
                    async () =>
                        (await page.eval(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('data-focused') === 'true'`)) === true,
                    { ceilingMs: CLICK_BUDGET_MS + 2_000, intervalMs: 25 }
                );
                if (flipped) landedMs = Date.now() - clickedAt;
            }
            clickResults.push({ index: i + 1, via, workspace: incoming.name, paneID: target, appeared, landedMs, at });
            event('click', { index: i + 1, landedMs, appeared });

            // Probe C: once this switch has settled, only the incoming web pane may be in the window.
            await settle(async () => ownerOf(incoming.web)?.owner === 'main', { ceilingMs: 5_000, intervalMs: 25 });
            await sleep(250);
            occlusion.push({
                index: i + 1,
                workspace: incoming.name,
                incoming: ownerOf(incoming.web)?.owner ?? 'never-placed',
                outgoing: ownerOf(outgoing.web)?.owner ?? 'never-placed'
            });
            await sleep(options.intervalMs);
        }
        const clicksEnd = Date.now();
        await sleep(SETTLE_WINDOW_MS);
        phase = 'done';
        await sleep(200);
        sampling = false;
        clearInterval(sampler);
        // Let the outstanding evaluates come home before anything is scored.
        await settle(async () => timeline.samples.every((entry) => entry.rtt !== null), { ceilingMs: 90_000, intervalMs: 100 });

        // ── scoring ─────────────────────────────────────────────────────────────────
        const stormWindow = window(timeline.samples, stormSwitches[0].at, stormEnd + SETTLE_WINDOW_MS);
        const clickWindow = window(timeline.samples, clickResults[0].at, clicksEnd + SETTLE_WINDOW_MS);
        const stormValues = stormWindow.map((entry) => entry.rtt);
        const clickValues = clickWindow.map((entry) => entry.rtt);
        const perSwitch = stormSwitches.map((entry) => {
            const values = window(timeline.samples, entry.at, entry.at + SETTLE_WINDOW_MS).map((s) => s.rtt);
            return { ...entry, samples: values.length, p95: percentile(values, 95), max: Math.max(0, ...values) };
        });
        const worst = [...perSwitch].sort((a, b) => b.max - a.max)[0];
        const freezes = timeline.samples.filter((entry) => entry.rtt > FREEZE_MS);
        const longest = Math.max(0, ...timeline.samples.map((entry) => entry.rtt ?? 0));

        log('');
        log(`PROBE A  responsiveness (${String(timeline.samples.length)} samples at ${String(options.sampleMs)} ms)`);
        log(`  storm   p50 ${String(percentile(stormValues, 50))} · p95 ${String(percentile(stormValues, 95))} · ` +
            `max ${String(Math.max(0, ...stormValues))} ms over ${String(stormValues.length)} samples`);
        log(`  clicks  p50 ${String(percentile(clickValues, 50))} · p95 ${String(percentile(clickValues, 95))} · ` +
            `max ${String(Math.max(0, ...clickValues))} ms over ${String(clickValues.length)} samples`);
        log(`  worst switch: #${String(worst.index)} via ${worst.via} → ${worst.workspace}, ` +
            `p95 ${String(worst.p95)} ms, max ${String(worst.max)} ms`);
        log(`  reload  p50 ${String(percentile(reloadValues, 50))} · p95 ${String(percentile(reloadValues, 95))} · ` +
            `max ${String(Math.max(0, ...reloadValues))} ms over ${String(reloadValues.length)} samples`);
        log(`  round trips over ${String(FREEZE_MS)} ms: ${String(freezes.length)} (longest ${String(longest)} ms)`);

        check(
            `the window rebuilds a workspace of ${String(options.panes)} heavy panes without a round trip over ${String(FREEZE_MS)} ms`,
            Math.max(0, ...reloadValues) <= FREEZE_MS,
            `p95 ${String(percentile(reloadValues, 95))} ms, max ${String(Math.max(0, ...reloadValues))} ms over ` +
                `${((reloadReadyAt - reloadAt) / 1000).toFixed(1)} s, ISSUE #78's mount flush`
        );
        check(`no round trip over ${String(FREEZE_MS)} ms during the storm`, freezes.length === 0,
            freezes.length === 0 ? `longest ${String(longest)} ms` : `${String(freezes.length)} of ${String(timeline.samples.length)} samples, longest ${String(longest)} ms, ISSUE #78`);
        check(`p95 under ${String(P95_BUDGET_MS)} ms across every switch and the ${String(SETTLE_WINDOW_MS / 1000)} s behind it`,
            perSwitch.every((entry) => entry.p95 < P95_BUDGET_MS),
            `worst p95 ${String(Math.max(0, ...perSwitch.map((entry) => entry.p95)))} ms`);
        check(`max under ${String(MAX_BUDGET_MS)} ms across every switch and the ${String(SETTLE_WINDOW_MS / 1000)} s behind it`,
            perSwitch.every((entry) => entry.max < MAX_BUDGET_MS),
            `worst max ${String(Math.max(0, ...perSwitch.map((entry) => entry.max)))} ms`);

        log('');
        const landed = clickResults.filter((entry) => entry.landedMs !== null && entry.landedMs <= CLICK_BUDGET_MS);
        log(`PROBE B  clicks land: ${String(landed.length)}/${String(clickResults.length)} within ${String(CLICK_BUDGET_MS)} ms ` +
            `(slowest ${String(Math.max(0, ...clickResults.map((entry) => entry.landedMs ?? 0)))} ms)`);
        check(`every one of ${String(clickResults.length)} post-switch header clicks focused its pane within ${String(CLICK_BUDGET_MS)} ms`,
            landed.length === clickResults.length,
            clickResults.filter((entry) => !landed.includes(entry)).map((entry) => `#${String(entry.index)}:${String(entry.landedMs)}`).join(' '));

        log('');
        const wrong = occlusion.filter((entry) => entry.incoming !== 'main' || entry.outgoing !== 'holder');
        log(`PROBE C  native occlusion: ${String(occlusion.length - wrong.length)}/${String(occlusion.length)} switches left only the incoming web pane in the window`);
        check('after every switch only the incoming workspace’s web pane is owner=main', wrong.length === 0,
            wrong.map((entry) => `#${String(entry.index)} ${entry.workspace}: in=${entry.incoming} out=${entry.outgoing}`).join(' · '));

        const summary = {
            options: {
                ...options,
                historyBytes,
                historyLines: measured.split('\n').length,
                replayBytes,
                replayTotalBytes: replayTotal
            },
            placement: t.windowPlacement,
            probeA: {
                samples: timeline.samples.length,
                baseline: stats(baseline),
                reload: { ...stats(reloadValues), rebuiltMs: reloadReadyAt - reloadAt, rebuilt },
                storm: stats(stormValues),
                clicks: stats(clickValues),
                perSwitch,
                over1000ms: freezes.length,
                longestMs: longest
            },
            probeB: { landed: landed.length, of: clickResults.length, results: clickResults },
            probeC: { clean: occlusion.length - wrong.length, of: occlusion.length, results: occlusion },
            checks: results
        };
        fs.writeFileSync(path.join(options.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
        fs.writeFileSync(path.join(options.out, 'timeline.json'), `${JSON.stringify(timeline, null, 2)}\n`);
        log('');
        log(`  summary  ${path.join(options.out, 'summary.json')}`);
        log(`  timeline ${path.join(options.out, 'timeline.json')}`);

        exitCode = results.some((entry) => !entry.ok) ? 1 : 0;
    } finally {
        clearInterval(sampler);
        clearInterval(pump);
        try {
            site.server.close();
        } catch {
            /* already closed */
        }
        if (options.keep) log(`  --keep: sandbox left at ${t.sandbox.root} (debug port ${String(t.debugPort)})`);
        else await t.stop();
    }

    log('');
    const failed = results.filter((entry) => !entry.ok);
    log(`${String(results.length - failed.length)}/${String(results.length)} probes passed`);
    process.exitCode = exitCode;
}

/**
 * What one pane's attach replay actually WEIGHS, read off the wire.
 *
 * `pane capture` prints the daemon's VT as plain text, and the payload under test is the
 * SERIALIZED snapshot: the same rows plus every SGR sequence needed to reproduce their
 * attributes, which for a coloured buffer is several times the text. So the harness attaches to
 * the daemon as a second client: the protocol by hand, exactly as `resize-flash-storm.mjs`
 * does: takes the replay frame's length, and detaches. It never writes to a pane, and the
 * app's own client is untouched (streams are per client, `daemon/src/ws/streams.ts`).
 */
async function measureReplays(sandbox, paneIDs, { cols, rows }) {
    const FRAME = { input: 0x02, ack: 0x03, replay: 0x05 };
    const HEADER_BYTES = 17;
    const PROTOCOL_VERSION = 1;
    const token = fs.readFileSync(path.join(sandbox.runDir, `daemon-v${String(PROTOCOL_VERSION)}.token`), 'utf8').trim();
    const uuidFromBytes = (bytes, offset = 0) => {
        const HEX = '0123456789ABCDEF';
        let out = '';
        for (let i = 0; i < 16; i += 1) {
            const byte = bytes[offset + i];
            out += HEX[(byte >> 4) & 0xf] + HEX[byte & 0xf];
            if (i === 3 || i === 5 || i === 7 || i === 9) out += '-';
        }
        return out;
    };
    const ws = new WebSocket(`${sandbox.base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
    ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });
    const sizes = new Map();
    ws.on('message', (data, isBinary) => {
        if (!isBinary) return;
        const bytes = new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length);
        if (bytes[0] !== FRAME.replay) return;
        const paneID = uuidFromBytes(bytes, 1);
        if (!sizes.has(paneID)) sizes.set(paneID, bytes.length - HEADER_BYTES);
    });
    ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, token, client: { kind: 'browser', name: 'switch-freeze-measure' } }));
    await sleep(300);
    for (const paneID of paneIDs) ws.send(JSON.stringify({ type: 'attach-pane', paneID, cols, rows }));
    await settle(async () => sizes.size >= paneIDs.length, { ceilingMs: 30_000, intervalMs: 100 });
    for (const paneID of paneIDs) ws.send(JSON.stringify({ type: 'detach-pane', paneID }));
    await sleep(200);
    ws.close();
    return paneIDs.map((paneID) => sizes.get(paneID.toUpperCase()) ?? sizes.get(paneID) ?? 0);
}

function stats(values) {
    return {
        n: values.length,
        p50: percentile(values, 50),
        p95: percentile(values, 95),
        p99: percentile(values, 99),
        max: Math.max(0, ...values)
    };
}

function window(samples, from, to) {
    return samples.filter((entry) => entry.rtt !== null && entry.at >= from && entry.at <= to);
}

/** The sidebar row, clicked where a person clicks it. */
async function clickWorkspaceRow(page, name) {
    const target = await page.eval(
        `(() => {
            const row = Array.from(document.querySelectorAll('[data-testid="workspace-row"]'))
                .find(el => (el.textContent ?? '').includes(${JSON.stringify(name)}));
            if (row === undefined) return null;
            const r = row.getBoundingClientRect();
            return JSON.stringify({ x: r.x + Math.min(60, r.width / 2), y: r.y + r.height / 2 });
        })()`
    );
    if (target === null) throw new Error(`no sidebar row for ${name}`);
    const point = JSON.parse(String(target));
    await page.clickAt(point.x, point.y);
}

/** Switch and wait for it, for the SETUP's sake: the storm never waits. */
async function activate(page, name) {
    await clickWorkspaceRow(page, name);
    await settle(async () =>
        (await page.eval(
            `(document.querySelector('[data-testid="workspace-row"][data-active="true"]')?.textContent ?? '')
                .includes(${JSON.stringify(name)})`
        )) === true, { ceilingMs: 20_000 });
}

main().catch((error) => {
    log(`\nharness error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 1;
});
