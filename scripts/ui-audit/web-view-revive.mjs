#!/usr/bin/env node
/**
 * Issue #34's live harness: does a web pane's page come back after the client's socket drops?
 *
 * The unit tests pin the wire - the client re-states its placements, the daemon asks it to - but
 * every one of them runs in jsdom, which has no compositor and no native views. The thing the
 * issue is actually about is a `WebContentsView` sitting in the shell's off-screen holder, and
 * nothing in jsdom can be in a holder. So this file stands up a real stack and asks the shell.
 *
 * The instrument is one line the shell already logs (`shell/src/webhost/index.ts:416`):
 *
 *     web pane <id> view owner=main|holder bounds=x,y w×h (reason)
 *
 * `owner=main` means the view is in the window, `owner=holder` means it is parked off screen.
 * It is the ONLY external observable for this, exactly as `poster-swap-flicker.mjs` documents:
 * a native view is composited by the window and never appears in the renderer's own frames, so a
 * screenshot of the page shows the hole as empty whether the page is there or not.
 *
 * **The trigger is a FROZEN daemon**, `SIGSTOP` then `SIGCONT` on the sandbox's own daemon pid
 * (asserted to be this script's child before anything touches it). The client pings the daemon
 * every 15 s and gives it 10 s to answer; a frozen daemon answers nothing, so the client
 * concludes the connection is dead, closes it and redials - which is exactly what a throttled
 * renderer does in the wild, reached for a spurious reason there and a real one here.
 *
 * **The freeze has to last at least 45 s**, and 40 is not enough: the check is a fixed 15 s
 * interval, so the tick that notices the silence lands up to 30 s after the freeze (a tick that
 * fires less than 15 s after the last inbound frame skips), and the tick that calls it dead is
 * one interval after that. Thawing before then lets the daemon answer the pending ping and
 * clears the state. Measured: a 40 s freeze produced no drop at all. 70 s is used here for
 * margin, because the cost of over-waiting is seconds and the cost of under-waiting is a run
 * that proves nothing.
 *
 * The first cut used CDP network emulation on the renderer target instead, which would have been
 * two seconds rather than forty. **It does not work**: `Network.emulateNetworkConditions` with
 * `offline:true` leaves an already-open WebSocket to 127.0.0.1 connected, and 20 s of waiting
 * produced no drop at all. That is recorded here because it is exactly the kind of plausible
 * trigger a reader would otherwise try next.
 *
 * What it asserts, in order, each one a link in the issue's own chain:
 *
 *   1. the pane's view is in the window to begin with;
 *   2. the freeze really does drop and re-establish the client's socket, observed as CDP
 *      WebSocket lifecycle events rather than inferred from a sleep;
 *   3. the view is placed again afterwards with NO user action, no resize, no click - the fix,
 *      and the one assertion that flips when the fix is reverted;
 *   4. a pane hidden on purpose (workspace switched away) is NOT re-placed by a reconnect,
 *      which is the one way this fix could plausibly become a worse bug than the one it fixes;
 *   5. and that pane still comes back when the user asks for it, so 4 is not just deadness.
 *
 * The park itself is reported but NOT asserted, and the reason is the fix's own race guard:
 * `releaseGeometry` skips a pane a live session in the same window is already claiming, so a
 * reconnect fast enough to beat the old socket's close through the daemon legitimately produces
 * no park at all. "Was it parked" is therefore diagnostic; "is it placed at the end" is the test.
 *
 *     node scripts/ui-audit/web-view-revive.mjs [--no-build] [--verbose] [--keep]
 *          [--window hidden|offscreen|onscreen|default]
 *
 * Exit code 0 = every assertion held. Run it against a tree with the fix reverted and assertion
 * 3 fails while 1, 2, 4 and 5 pass: that is the shape of issue #34, and it is what makes a green
 * run mean anything.
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
    window: valued('--window', 'hidden')
};

const { buildAll, makeSandbox, startDaemon, startShell, waitForHealthz, makeCli, assertSandboxDaemon, waitFor, sleep } =
    await import(path.join(repoRoot, 'scripts', 'ui-audit', 'lib', 'stack.mjs'));
const { waitForPageTarget, connect } = await import(path.join(repoRoot, 'scripts', 'ui-audit', 'lib', 'cdp.mjs'));

const results = [];
const log = (line) => process.stdout.write(`${line}\n`);
function check(name, ok, detail = '') {
    results.push({ name, ok });
    log(`  ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : `  ${detail}`}`);
}

/** Something with obvious motion, so "the page never stopped running" is legible in a still. */
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Revive Fixture</title>
<style>html,body{margin:0;background:#101014;color:#7ee787;font:28px/1.4 ui-monospace,monospace}
#t{padding:24px}</style></head><body><div id="t">starting…</div>
<script>
  let n = 0;
  setInterval(() => { n += 1; document.getElementById('t').textContent = 'tick ' + n; }, 100);
</script></body></html>`;

async function main() {
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

    const sandbox = await makeSandbox(repoRoot, { label: 'revive', clientDir, auditWindow: options.window });
    const daemon = startDaemon(sandbox, { repoRoot, verbose: options.verbose });
    let shell = null;
    let page = null;
    try {
        await waitForHealthz(sandbox.base);
        // Never a step before this one: prove the process answering the sandbox port is the
        // daemon this script spawned, not the live app's. Everything below drives that daemon.
        await assertSandboxDaemon(sandbox, daemon.child.pid);
        log(`  sandbox daemon pid ${String(daemon.child.pid)} on control ${String(sandbox.controlPort)}`);

        const cli = makeCli(sandbox, { repoRoot });
        shell = startShell(sandbox, {
            repoRoot,
            verbose: options.verbose,
            extraEnv: { KELPI_AUDIT: '1', KELPI_AUDIT_WINDOW: options.window }
        });

        // The shell's placement lines, stamped as they arrive. Every assertion below is a
        // statement about this stream.
        const placements = [];
        let consumed = 0;
        const pump = setInterval(() => {
            while (consumed < shell.lines.length) {
                const line = shell.lines[consumed];
                consumed += 1;
                const match = /web pane ([0-9A-Fa-f-]{36}) view owner=(main|holder) bounds=(\S+ \S+|-) \(([^)]*)\)/.exec(
                    line
                );
                if (match === null) continue;
                placements.push({ at: Date.now(), paneID: match[1], owner: match[2], bounds: match[3], reason: match[4] });
            }
        }, 2);
        pump.unref?.();
        const ownerOf = (paneID) => placements.filter((entry) => entry.paneID === paneID).at(-1) ?? null;
        const sinceIndex = () => placements.length;
        const settleOwner = async (paneID, want, timeoutMs, label) => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                if (ownerOf(paneID)?.owner === want) return Date.now();
                await sleep(15);
            }
            log(`    (timed out waiting for ${label}: last = ${JSON.stringify(ownerOf(paneID))})`);
            return null;
        };

        const target = await waitForPageTarget(sandbox.debugPort, { match: (t) => t.url.includes('shellWindow=') });
        page = await connect(target.webSocketDebuggerUrl, { repoRoot, verbose: options.verbose });

        // The client's own socket, watched from the outside. `Network.enable` makes Chromium
        // report WebSocket lifecycle, so "it dropped and came back" is an observation rather
        // than a sleep with a hopeful comment on it.
        await page.send('Network.enable');
        const sockets = [];
        page.on('Network.webSocketCreated', (params) => {
            if (String(params.url ?? '').includes('/ws')) sockets.push({ at: Date.now(), event: 'created' });
        });
        page.on('Network.webSocketClosed', () => sockets.push({ at: Date.now(), event: 'closed' }));
        page.on('Network.webSocketHandshakeResponseReceived', () =>
            sockets.push({ at: Date.now(), event: 'handshake' })
        );

        /**
         * Freeze the daemon until the client gives up on it, then thaw. Only ever this script's
         * own child: `assertSandboxDaemon` above proved the pid, and nothing else is signalled.
         */
        const freezeDaemon = async (ms) => {
            process.kill(daemon.child.pid, 'SIGSTOP');
            try {
                await sleep(ms);
            } finally {
                process.kill(daemon.child.pid, 'SIGCONT');
            }
        };

        const created = await cli.run(['workspace', 'create', '--name', 'revive'], { timeoutMs: 40_000 });
        if (created.code !== 0) throw new Error(`workspace create failed: ${created.stderr || created.stdout}`);
        await waitFor(
            'the workspace to be active on screen',
            async () =>
                (await page.eval(
                    `(document.querySelector('[data-testid="workspace-row"][data-active="true"]')?.textContent ?? '')
                        .includes('revive')`
                )) === true,
            30_000
        );

        const opened = await cli.run(['web', 'open', site.url], { timeoutMs: 60_000 });
        const paneID = (/open ok:\s*([0-9a-f-]{36})/i.exec(opened.stdout) ?? [])[1];
        if (paneID === undefined) throw new Error(`no web pane opened: ${opened.stdout}${opened.stderr}`);

        // ── 1. the view is in the window to begin with ──────────────────────────────
        const placedAt = await settleOwner(paneID, 'main', 30_000, 'the first placement');
        check('the pane’s view starts in the window (owner=main)', placedAt !== null, ownerOf(paneID)?.bounds ?? '');
        if (placedAt === null) throw new Error('nothing was ever placed; the rest cannot be measured');
        // Let the layout stop moving, so the drop below happens against a STILL layout - which is
        // the whole precondition of the bug (a layout that moves repairs itself by accident).
        await sleep(1500);
        const beforeDrop = ownerOf(paneID);

        // ── 2. the freeze really drops and re-establishes the client's socket ──────
        const socketMark = sockets.length;
        const placementMark = sinceIndex();
        const frozenAt = Date.now();
        log('  freezing the sandbox daemon for 70 s so the client gives up on it…');
        await freezeDaemon(70_000);
        const thawedAt = Date.now();

        const reconnected = await waitFor(
            'the client to close its socket and dial a new one',
            async () => {
                const since = sockets.slice(socketMark);
                return (
                    since.some((entry) => entry.event === 'closed') &&
                    since.some((entry) => entry.event === 'handshake')
                );
            },
            30_000
        ).then(
            () => true,
            () => false
        );
        check(
            'the freeze drops the client’s socket and it dials a new one',
            reconnected,
            JSON.stringify(sockets.slice(socketMark).map((entry) => `${entry.event}+${String(entry.at - frozenAt)}ms`))
        );

        // ── 3. the view is placed again, with no user action ────────────────────────
        const backAt = await settleOwner(paneID, 'main', 30_000, 'the recovery');
        const parked = placements.slice(placementMark).filter((e) => e.paneID === paneID && e.owner === 'holder');
        log(
            `  (diagnostic) park observed: ${parked.length === 0 ? 'no' : `yes, ${String(parked.length)}x, reason=${String(parked.at(-1)?.reason)}`}`
        );
        check(
            'the view is placed again after the reconnect, with no user action (owner=main)',
            backAt !== null,
            backAt === null
                ? 'ISSUE #34: the page is still in the holder'
                : `${String(backAt - thawedAt)} ms after the daemon thawed`
        );
        const backBounds = ownerOf(paneID)?.bounds ?? '';
        check(
            'it is in the same box it left',
            backAt !== null && backBounds === beforeDrop?.bounds,
            `${String(beforeDrop?.bounds)} → ${backBounds}`
        );
        // Nothing touched the page, so it must never have stopped running.
        const ticked = await cli.run(['web', 'text', '#t', '--target', paneID], { timeoutMs: 30_000 });
        check(
            'the page kept running the whole time',
            /tick \d+/.test(ticked.stdout),
            `${ticked.stdout.trim()}${ticked.stderr.trim() === '' ? '' : ` [stderr: ${ticked.stderr.trim()}]`}`
        );
        if (options.verbose) {
            for (const entry of placements.slice(placementMark)) log(`    ${JSON.stringify(entry)}`);
        }

        // ── 4. a pane hidden on purpose must NOT come back ──────────────────────────
        const second = await cli.run(['workspace', 'create', '--name', 'elsewhere'], { timeoutMs: 40_000 });
        if (second.code !== 0) throw new Error(`second workspace create failed: ${second.stderr || second.stdout}`);
        const hiddenAt = await settleOwner(paneID, 'holder', 20_000, 'the workspace switch to park it');
        check('switching workspace still parks the view', hiddenAt !== null, ownerOf(paneID)?.reason ?? '');

        await sleep(1500);
        const hiddenMark = sinceIndex();
        log('  freezing again, this time with the pane legitimately hidden…');
        await freezeDaemon(70_000);
        // Generous: if the fix were going to wrongly re-place it, it would do so within a frame
        // of `welcome`, and this is several seconds of grace on top.
        await sleep(10_000);
        const wrongly = placements.slice(hiddenMark).filter((entry) => entry.paneID === paneID && entry.owner === 'main');
        check(
            'a pane hidden on purpose is NOT re-placed by a reconnect',
            wrongly.length === 0 && ownerOf(paneID)?.owner === 'holder',
            wrongly.length === 0 ? `still ${String(ownerOf(paneID)?.owner)}` : JSON.stringify(wrongly)
        );

        // ── 5. …and it still comes back when the user asks ──────────────────────────
        await page.eval(`(() => {
            const rows = [...document.querySelectorAll('[data-testid="workspace-row"]')];
            const row = rows.find((r) => (r.textContent ?? '').includes('revive'));
            row?.click();
            return row !== undefined;
        })()`);
        const returnedAt = await settleOwner(paneID, 'main', 20_000, 'the switch back');
        check('switching back to its workspace places it again', returnedAt !== null, ownerOf(paneID)?.bounds ?? '');
    } finally {
        try {
            site.server.close();
        } catch {
            /* already closed */
        }
        if (page !== null) {
            try {
                await page.close?.();
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
        for (const entry of failed) log(`  FAILED: ${entry.name}`);
        process.exitCode = 1;
    }
}

main().catch((error) => {
    log(`\nharness error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 1;
});
