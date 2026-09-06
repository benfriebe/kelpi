#!/usr/bin/env node
/**
 * Issue #75's live harness: does a web pane's page come back after the WINDOW is hidden?
 *
 * The sibling of `./web-view-revive.mjs` (#34), against the route that fix did not claim. There
 * the trigger was the client's socket; here it is the user's own hands: ⌘H, ⌥⌘H from another
 * app, ⌘M, or the global hotkey's second press. The shell parks every web pane's view in its
 * off-screen holder on `hide` and `minimize`, and before this fix it DELETED the placement, so
 * nothing ever put the page back: the client's geometry reporter dedupes an identical
 * re-render, so it had nothing to say, and no event follows an unhide. Every web pane came back
 * an empty hole with its chrome still drawn round it.
 *
 * The instrument is the same one line the shell already logs (`shell/src/webhost/index.ts`):
 *
 *     web pane <id> view owner=main|holder bounds=x,y w×h (reason)
 *
 * `owner=main` means the view is in the window, `owner=holder` means it is parked off screen.
 * It is the ONLY external observable for this: a native view is composited by the window and
 * never appears in the renderer's own frames, so a screenshot of the page shows the hole as
 * empty whether the page is there or not.
 *
 * **The trigger is the real window, moved through the harness channel.** `hide`, `minimize` and
 * `restore` are ops this issue added to `packages/shell/src/harness-protocol.ts`, and they are
 * real `BrowserWindow` calls rather than synthesised events: the behaviour under test is what
 * the shell does in its own handlers, and firing the event by hand would run the handler while
 * leaving the window (and the views parented to it) exactly where they were. They could not be
 * driven any other way, either: ⌘H and ⌘M are `role` rows, which `menu-click` refuses.
 *
 * What it asserts, in order, each one a link in the issue's own chain:
 *
 *   1. the pane's view is in the window to begin with;
 *   2. hiding the window parks it, with the shell's own reason (`window-hidden`);
 *   3. showing the window places it again, with no user action and no re-render - the fix, and
 *      one of the two assertions that flip when the fix is reverted;
 *   4. it comes back in the box it left;
 *   5. minimising parks it (`window-minimized`);
 *   6. restoring places it again - the second assertion that flips;
 *   7. a pane hidden ON PURPOSE (its workspace switched away) is NOT re-placed by a hide/show
 *      cycle, which is the one way this fix could become a worse bug than the one it fixes;
 *   8. …and that pane still comes back when the user asks for it, so 7 is not just deadness;
 *   9. the page kept running the whole time.
 *
 * A real Space switch is the case the owner reported and Electron has no API for one, so it
 * stays a manual acceptance step; hide/show is the same code path (`windowMetrics()` refuses a
 * window that is not visible either way).
 *
 *     node scripts/ui-audit/web-view-restore.mjs [--no-build] [--verbose] [--keep]
 *          [--window hidden|offscreen|onscreen|default]
 *
 * `--window hidden` is the default and is what makes this safe to run beside other work: the
 * window is at zero opacity and click-through, `hide()` and `show()` behave exactly as they do
 * at any placement (opacity is not touched by either), and nothing here measures pixels.
 *
 * Exit code 0 = every assertion held. Run it against a tree with `restoreViews` unwired and
 * assertions 3, 4 and 6 fail while the rest pass: that is the shape of issue #75, and it is what
 * makes a green run mean anything.
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
    build: !has('--no-build'),
    keep: has('--keep'),
    verbose: has('--verbose'),
    window: valued('--window', 'hidden')
};

const { buildAll, makeSandbox, startDaemon, startShell, waitForHealthz, makeCli, assertSandboxDaemon, waitFor, sleep } =
    await import(path.join(repoRoot, 'scripts', 'ui-audit', 'lib', 'stack.mjs'));
const { waitForPageTarget, connect } = await import(path.join(repoRoot, 'scripts', 'ui-audit', 'lib', 'cdp.mjs'));
const { harnessClient } = await import(path.join(repoRoot, 'scripts', 'ui-audit', 'lib', 'driver.mjs'));

const results = [];
const log = (line) => process.stdout.write(`${line}\n`);
function check(name, ok, detail = '') {
    results.push({ name, ok });
    log(`  ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : `  ${detail}`}`);
}

/** Something with obvious motion, so "the page never stopped running" is legible in a still. */
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Restore Fixture</title>
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

    const sandbox = await makeSandbox(repoRoot, { label: 'restore', clientDir, auditWindow: options.window });
    // `let`, because the last section restarts it: issue #72 needs the host's slot to be empty,
    // and only a daemon that went away and came back produces that.
    let daemon = startDaemon(sandbox, { repoRoot, verbose: options.verbose });
    let shell = null;
    let page = null;
    let harness = null;
    try {
        await waitForHealthz(sandbox.base);
        // Never a step before this one: prove the process answering the sandbox port is the
        // daemon this script spawned, not the live app's.
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
                await sleep(5);
            }
            log(`    (timed out waiting for ${label}: last = ${JSON.stringify(ownerOf(paneID))})`);
            return null;
        };

        const target = await waitForPageTarget(sandbox.debugPort, { match: (t) => t.url.includes('shellWindow=') });
        page = await connect(target.webSocketDebuggerUrl, { repoRoot, verbose: options.verbose });

        // The window itself, through the shell's own control channel. Nothing else can move it:
        // CDP drives the renderer, and ⌘H / ⌘M are native `role` rows.
        harness = harnessClient(sandbox.harnessSocket);
        await waitFor(
            'the shell harness channel to answer',
            async () => {
                try {
                    await harness.ping();
                    return true;
                } catch {
                    return false;
                }
            },
            30_000
        );

        const created = await cli.run(['workspace', 'create', '--name', 'restore'], { timeoutMs: 40_000 });
        if (created.code !== 0) throw new Error(`workspace create failed: ${created.stderr || created.stdout}`);
        await waitFor(
            'the workspace to be active on screen',
            async () =>
                (await page.eval(
                    `(document.querySelector('[data-testid="workspace-row"][data-active="true"]')?.textContent ?? '')
                        .includes('restore')`
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
        // Let the layout stop moving, so the hide below happens against a STILL layout - which is
        // the whole precondition of the bug (a layout that moves repairs itself by accident).
        await sleep(1500);
        const beforeHide = ownerOf(paneID);

        // ── 2. hiding the window parks the view ────────────────────────────────────
        //
        // The reason is reported rather than pinned to one string, and that is a finding rather
        // than a looser test: measured on this Electron, `app.hide()` (which is what ⌘H is)
        // often emits no `hide` event on the window at all, so what parks the view is usually
        // the host's own reconciler noticing the window is gone (`window-not-visible`) and not
        // the event (`window-hidden`). Either is a correct park; requiring the event would pin
        // the test to a platform behaviour the fix deliberately does not rely on.
        const hidden = await harness.hide();
        const hiddenAt = await settleOwner(paneID, 'holder', 10_000, 'the hide to park it');
        const parkReason = ownerOf(paneID)?.reason ?? 'no park at all';
        check(
            'hiding the window parks the view (owner=holder)',
            hiddenAt !== null && (parkReason === 'window-hidden' || parkReason === 'window-not-visible'),
            `${JSON.stringify(hidden)} · reason=${parkReason} · ${String((hiddenAt ?? 0) - (beforeHide?.at ?? 0))} ms after the pane settled`
        );

        // Long enough that a recovery which depended on a re-render, a resize or a report would
        // have happened by now. The bug is permanent, so any wait proves the same thing; this
        // one is chosen to be longer than the client's own throttle window by an order.
        await sleep(3000);

        // ── 3. showing it places the view again, with no user action ───────────────
        const shownRequestedAt = Date.now();
        const shown = await harness.restore();
        const backAt = await settleOwner(paneID, 'main', 10_000, 'the restore after a hide');
        check(
            'showing the window places the view again, with no user action (owner=main)',
            backAt !== null,
            backAt === null
                ? 'ISSUE #75: the page is still in the holder'
                : `${String(backAt - shownRequestedAt)} ms after show() · ${JSON.stringify(shown)}`
        );
        const backBounds = ownerOf(paneID)?.bounds ?? '';
        check(
            'it is in the same box it left',
            backAt !== null && backBounds === beforeHide?.bounds,
            `${String(beforeHide?.bounds)} -> ${backBounds}`
        );

        // ── 5. and the same for minimise / restore ─────────────────────────────────
        await sleep(1000);
        const minimised = await harness.minimize();
        const minimisedAt = await settleOwner(paneID, 'holder', 10_000, 'the minimise to park it');
        check(
            'minimising the window parks the view (owner=holder, window-minimized)',
            minimisedAt !== null && ownerOf(paneID)?.reason === 'window-minimized',
            `${JSON.stringify(minimised)} · ${ownerOf(paneID)?.reason ?? 'no park at all'}`
        );
        await sleep(2000);
        const restoreRequestedAt = Date.now();
        const restored = await harness.restore();
        const afterRestore = await settleOwner(paneID, 'main', 10_000, 'the restore after a minimise');
        check(
            'restoring the window places the view again (owner=main)',
            afterRestore !== null,
            afterRestore === null
                ? 'ISSUE #75: the page is still in the holder'
                : `${String(afterRestore - restoreRequestedAt)} ms after restore() · ${JSON.stringify(restored)}`
        );

        // ── 7. a pane hidden on purpose must NOT come back ─────────────────────────
        //
        // The one way this fix could be worse than the bug: a park the CLIENT asked for is not
        // the shell's to undo, and a restore that resurrected it would put a page the user
        // navigated away from back on top of the workspace they are looking at.
        const second = await cli.run(['workspace', 'create', '--name', 'elsewhere'], { timeoutMs: 40_000 });
        if (second.code !== 0) throw new Error(`second workspace create failed: ${second.stderr || second.stdout}`);
        const parkedOnPurposeAt = await settleOwner(paneID, 'holder', 20_000, 'the workspace switch to park it');
        check(
            'switching workspace still parks the view',
            parkedOnPurposeAt !== null,
            ownerOf(paneID)?.reason ?? ''
        );

        await sleep(1000);
        const purposeMark = sinceIndex();
        await harness.hide();
        await sleep(1000);
        await harness.restore();
        // Generous: if the fix were going to wrongly re-place it, it would do so within a frame
        // of `show`, and this is several seconds of grace on top.
        await sleep(4000);
        const wrongly = placements.slice(purposeMark).filter((entry) => entry.paneID === paneID && entry.owner === 'main');
        check(
            'a pane hidden on purpose is NOT re-placed by a hide/show cycle',
            wrongly.length === 0 && ownerOf(paneID)?.owner === 'holder',
            wrongly.length === 0 ? `still ${String(ownerOf(paneID)?.owner)}` : JSON.stringify(wrongly)
        );

        // ── 8. …and it still comes back when the user asks ─────────────────────────
        await page.eval(`(() => {
            const rows = [...document.querySelectorAll('[data-testid="workspace-row"]')];
            const row = rows.find((r) => (r.textContent ?? '').includes('restore'));
            row?.click();
            return row !== undefined;
        })()`);
        const returnedAt = await settleOwner(paneID, 'main', 20_000, 'the switch back');
        check('switching back to its workspace places it again', returnedAt !== null, ownerOf(paneID)?.bounds ?? '');

        // ── 9. nothing touched the page, so it must never have stopped running ─────
        const ticked = await cli.run(['web', 'text', '#t', '--target', paneID], { timeoutMs: 30_000 });
        check(
            'the page kept running the whole time',
            /tick \d+/.test(ticked.stdout),
            `${ticked.stdout.trim()}${ticked.stderr.trim() === '' ? '' : ` [stderr: ${ticked.stderr.trim()}]`}`
        );

        /*
         * ── 10. issue #72: a hide issued while the host slot was empty ─────────────
         *
         * The mirror of #34, and the half that fix does not reach: not a placement that was
         * lost, but a HIDE that was lost. The daemon drops geometry while no host is attached,
         * including `visible:false`; the shell keeps its views across a host socket drop on
         * purpose (that is what makes live pages survive a `kelpid` restart); and the client
         * cannot re-state a hide, because `reassert()` re-sends only placements and `hide()`
         * deletes the entry. So the pane's page stays on screen over the workspace the user
         * switched TO.
         *
         * The trigger is the issue's own: restart the daemon, and switch workspace while the
         * shell's host connection is still backing off (up to 15 s). The run dir keeps its
         * token, so the new daemon is the same daemon as far as every socket is concerned.
         *
         * A freeze (`SIGSTOP`, as `web-view-revive.mjs` uses for #34) is deliberately NOT the
         * trigger here and cannot be: the host's socket has no liveness check of its own, so a
         * frozen daemon leaves it connected and every message merely queued. Nothing empties
         * the host slot except the daemon actually going away.
         */
        log('  restarting the sandbox daemon so the host slot goes empty (issue #72)…');
        // Back to the pane's own workspace and make sure it is on screen first.
        await settleOwner(paneID, 'main', 20_000, 'the pane to be placed before the restart');
        await sleep(1000);
        const beforeRestart = ownerOf(paneID);
        const restartMark = sinceIndex();
        const shellMark = shell.lines.length;

        /*
         * SIGKILL, not the harness's ordinary `stop()`, and the difference is the whole test.
         * A daemon asked to stop politely REVOKES the host role first (`host-revoked` with
         * reason `shutdown`), and the shell answers that by destroying every view and every
         * placement - a different code path, which passes this assertion on any build. #72 is
         * about reason `disconnected`, the socket simply going away, which is the one case the
         * shell deliberately KEEPS its views for. Measured: with `stop()` the final park's
         * reason is `shutdown`; with SIGKILL it is `unclaimed-after-reconnect`.
         */
        daemon.child.kill('SIGKILL');
        await waitFor('the daemon to be gone', () => daemon.exited, 15_000);
        await daemon.stop();
        // Long enough for the host's reconnect backoff to grow past a couple of seconds: it
        // doubles on every failed dial (500 ms, 1 s, 2 s, 4 s, 8 s), and every dial while the
        // daemon is down fails. That is what buys the window the hide has to land in.
        await sleep(11_000);
        daemon = startDaemon(sandbox, { repoRoot, verbose: options.verbose });
        await waitForHealthz(sandbox.base, 30_000);
        await assertSandboxDaemon(sandbox, daemon.child.pid);

        // The client redials on its own within a second or so; the switch is a click in the UI,
        // exactly as a user would do it.
        const switchedAt = await waitFor(
            'the client to reconnect and take the workspace switch',
            async () =>
                (await page.eval(`(() => {
                    const rows = [...document.querySelectorAll('[data-testid="workspace-row"]')];
                    const row = rows.find((r) => (r.textContent ?? '').includes('elsewhere'));
                    row?.click();
                    return row !== undefined && !(row.getAttribute('data-active') === 'true');
                })()`)) === true
                    ? Date.now()
                    : false,
            30_000
        );

        const registeredLine = await waitFor(
            'the web host to register with the new daemon',
            async () => shell.lines.slice(shellMark).some((line) => /web host registered/.test(line)),
            40_000
        ).then(
            () => Date.now(),
            () => null
        );
        check(
            'the workspace switch happened while the host slot was empty (the precondition)',
            registeredLine !== null && registeredLine > switchedAt,
            registeredLine === null
                ? 'the host never re-registered'
                : `switch at +0 ms, host registered +${String(registeredLine - switchedAt)} ms`
        );

        const gone = await settleOwner(paneID, 'holder', 15_000, 'the stale placement to be dropped');
        const finalPark = placements.slice(restartMark).filter((entry) => entry.paneID === paneID).at(-1);
        check(
            'the outgoing pane’s view is off screen after the host re-registers (#72)',
            gone !== null,
            gone === null
                ? `ISSUE #72: still ${String(ownerOf(paneID)?.owner)} at ${String(beforeRestart?.bounds)}`
                : `reason=${String(finalPark?.reason)} · ${String(gone - switchedAt)} ms after the switch`
        );
        /*
         * The reason, because one way of passing this would be vacuous and two are not.
         *
         *   `unclaimed-after-reconnect`  the sweep: nobody re-stated the placement, so the host
         *                                dropped its own claim. This is the fix.
         *   `hidden`                     the client happened to re-state the hide after the
         *                                reconnect. It sometimes does and sometimes does not
         *                                (measured: three runs, two of each), which is exactly
         *                                why the issue calls the window narrow, and it is a
         *                                correct outcome by a route this PR did not add.
         *   `shutdown`                   the daemon revoked the role and the shell threw every
         *                                view away. That happens on a POLITE stop and passes on
         *                                any build, so it is refused here: the kill above is
         *                                what keeps this test about #72.
         */
        check(
            '…and not because the host role was revoked (which would pass on any build)',
            finalPark !== undefined && finalPark.reason !== 'shutdown',
            `reason=${String(finalPark?.reason)}`
        );

        if (options.verbose) {
            for (const entry of placements) log(`    ${JSON.stringify(entry)}`);
        }
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
