#!/usr/bin/env node
/**
 * Issue #76's live harness: does a web pane come back after its RENDERER dies?
 *
 * The neighbouring `web-view-revive.mjs` asks the same question about a dropped socket. This one
 * is about a page whose renderer process is simply gone: the view is still a child of the shell
 * window, still at the pane's bounds, and painting nothing. The user's words for it were
 * "sometimes web panes just go blank and only show the browser chrome, but aren't rendering the
 * body of the browser at all" and "no retry / reload option either".
 *
 * Why it cannot be a unit test. The recovery spans three processes - a renderer dies in the
 * shell, the shell disposes the view and tells the daemon, the daemon re-announces the pane, the
 * shell rebuilds and re-places it, the client draws a card if it does not - and the only part of
 * that a jsdom test can see is the last one. So this stands up a real stack, kills a real
 * renderer, and reads the shell's own log.
 *
 * **The trigger is the harness channel's `crash` op**, which calls
 * `webContents.forcefullyCrashRenderer()` on the named pane's active tab
 * (`packages/shell/src/webhost/index.ts` ▸ `crashPaneRenderer`). CDP's `Page.crash` was the
 * obvious alternative and does not work here: it needs a debugger attached to the PANE's own
 * target, and the shell's `--remote-debugging-port` exposes the window's page, not the
 * `WebContentsView` inside it (the shell attaches its own CDP session to each tab, and Chromium
 * hands a target to one debugger at a time). That is recorded because it is exactly what a
 * reader would otherwise try next.
 *
 * The instruments are two lines the shell already logs:
 *
 *     [shell] warning: web pane <id> tab <id>: renderer gone (crashed)     ← tab.ts
 *     [shell] web pane <id> view owner=main|holder bounds=x,y w×h (reason) ← webhost/index.ts
 *
 * `owner=main (attached)` after a crash means a NEW view was built and placed; `owner=holder`,
 * or no line at all, means the pane is still dead. As `web-view-revive.mjs` documents, a native
 * view is composited by the window and never appears in the renderer's own frames, so a
 * screenshot of the page shows the hole as empty whether the page is there or not.
 *
 * What it asserts, in order, each one a link in the issue's chain:
 *
 *   1. the pane's view is in the window and its page is readable to begin with;
 *   2. crashing it is logged as a renderer death, by the tab AND app-wide;
 *   3. the pane rebuilds ITSELF, once, with no user action: a fresh `owner=main (attached)` and
 *      the fixture's title back through `kelpi web url`;
 *   4. a SECOND crash inside the rebuild window does NOT rebuild - a page that crashes on load
 *      must not spin the host - and the client draws the "This page stopped responding" card;
 *   5. `kelpi web reload` on that dead pane rebuilds it instead of answering `no live tab`;
 *   6. and so does the card's own Reload button, clicked in the client's DOM.
 *
 *     node scripts/ui-audit/web-view-rebuild.mjs [--no-build] [--verbose] [--keep]
 *          [--window hidden|offscreen|onscreen|default]
 *
 * Exit code 0 = every assertion held. Against the shipped tree (the fix reverted) 1 and 2 pass,
 * 3 fails with the view still dead, 4's card never appears, and 5 comes back
 * `web pane has no live tab <uuid>`: that is the shape of issue #76, and it is what makes a
 * green run mean anything.
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

/** A title to read back, and a counter so "this is a NEW page" is legible in a still. */
const TITLE = 'Rebuild Fixture';
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>${TITLE}</title>
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

    const sandbox = await makeSandbox(repoRoot, { label: 'rebuild', clientDir, auditWindow: options.window });
    const daemon = startDaemon(sandbox, { repoRoot, verbose: options.verbose });
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

        // The shell's placement lines, stamped as they arrive. Assertions 1, 3, 4, 5 and 6 are
        // all statements about this stream.
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
        /** Wait for a NEW `owner=main (attached)` line, which is what "a fresh view" looks like. */
        const waitForAttach = async (paneID, mark, timeoutMs, label) => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const fresh = placements
                    .slice(mark)
                    .find((entry) => entry.paneID === paneID && entry.owner === 'main' && entry.reason === 'attached');
                if (fresh !== undefined) return fresh;
                await sleep(15);
            }
            log(`    (timed out waiting for ${label}: last = ${JSON.stringify(ownerOf(paneID))})`);
            return null;
        };
        const shellLines = (pattern) => shell.lines.filter((line) => pattern.test(line));

        const target = await waitForPageTarget(sandbox.debugPort, { match: (t) => t.url.includes('shellWindow=') });
        page = await connect(target.webSocketDebuggerUrl, { repoRoot, verbose: options.verbose });
        harness = harnessClient(sandbox.harnessSocket ?? path.join(sandbox.root, 'harness.sock'));

        const created = await cli.run(['workspace', 'create', '--name', 'rebuild'], { timeoutMs: 40_000 });
        if (created.code !== 0) throw new Error(`workspace create failed: ${created.stderr || created.stdout}`);
        await waitFor(
            'the workspace to be active on screen',
            async () =>
                (await page.eval(
                    `(document.querySelector('[data-testid="workspace-row"][data-active="true"]')?.textContent ?? '')
                        .includes('rebuild')`
                )) === true,
            30_000
        );

        const opened = await cli.run(['web', 'open', site.url], { timeoutMs: 60_000 });
        const paneID = (/open ok:\s*([0-9a-f-]{36})/i.exec(opened.stdout) ?? [])[1];
        if (paneID === undefined) throw new Error(`no web pane opened: ${opened.stdout}${opened.stderr}`);

        /**
         * Crash the pane, without letting a refusal end the run.
         *
         * The refusal is itself a symptom: against the shipped tree the registry drops a dead
         * tab without rebuilding it, so the second crash has nothing to kill and the op answers
         * `no live view for pane <id>`. Throwing there would abandon the control run three
         * assertions in, and the assertions after it - no card, and `web reload` answering
         * `no live tab` - are the ones that describe the bug most plainly.
         */
        const crashPane = async () => {
            try {
                return await harness.crash(paneID);
            } catch (error) {
                return { crashed: false, error: error instanceof Error ? error.message : String(error) };
            }
        };
        const cardUp = async () =>
            (await page.eval(
                `document.querySelector('[data-testid="web-crashed-${paneID}"]') !== null`
            )) === true;
        /**
         * "Is there a page there", asked with a verb that needs one.
         *
         * NOT `kelpi web url`: §8.2 makes it answer from daemon STATE when the host round trip
         * fails, so a dead pane still prints the URL and title it had before it died and the
         * check would pass against the very bug it is here to catch. `web text` has no fallback:
         * it reaches the page or it fails `web pane has no live tab`. The title is read
         * alongside it and reported, because it is what a person would look at.
         */
        const pageAlive = async (label) => {
            const read = await cli.run(['web', 'text', '#t', '--target', paneID], { timeoutMs: 30_000 });
            const url = await cli.run(['web', 'url', '--target', paneID], { timeoutMs: 30_000 });
            const ok = /tick \d+/.test(read.stdout) && url.stdout.includes(TITLE);
            const detail = `${label}: ${read.stdout.trim().replace(/\s+/g, ' ')} | ${url.stdout.trim().replace(/\s+/g, ' ')}${
                read.stderr.trim() === '' ? '' : ` [stderr: ${read.stderr.trim()}]`
            }`;
            return { ok, detail };
        };

        // ── 1. the pane is alive to begin with ─────────────────────────────────────
        const first = await waitForAttach(paneID, 0, 30_000, 'the first placement');
        check('the pane’s view starts in the window (owner=main, attached)', first !== null, first?.bounds ?? '');
        if (first === null) throw new Error('nothing was ever placed; the rest cannot be measured');
        const before = await waitFor(
            'the fixture to start ticking',
            async () => (await pageAlive('before the crash')).ok,
            30_000
        ).then(() => true, () => false);
        check('its page is readable before anything is crashed', before, (await pageAlive('before the crash')).detail);
        check('no card is up on a healthy pane', !(await cardUp()));
        // Let the layout stop moving, so the crash lands against a STILL layout.
        await sleep(1500);
        const healthyBounds = ownerOf(paneID)?.bounds ?? '';

        // ── 2. crash it, and see the death reported ────────────────────────────────
        let mark = sinceIndex();
        const crashAt = Date.now();
        const crashed = await crashPane();
        check('the harness crashes the pane’s renderer', crashed?.crashed === true, JSON.stringify(crashed));
        const gone = await waitFor(
            'the shell to log the renderer death',
            async () => shellLines(/renderer gone/).length > 0,
            20_000
        ).then(() => true, () => false);
        check('the shell logs `renderer gone` for that tab', gone, shellLines(/renderer gone/).at(-1) ?? '');
        /*
         * The app-level half of #76's instrumentation. Two events are registered together in
         * `main.ts` because Electron splits them: `child-process-gone` fires for the GPU,
         * utility, zygote and sandbox helpers and explicitly NOT for renderers, so this is the
         * one of the pair a crash can actually trigger. The GPU half cannot be raised on demand
         * from a test - killing the GPU process is not something the harness may do to the
         * machine it runs on - so what is asserted here is that the registration block runs and
         * reports; the GPU line is the same three-line handler beside it.
         */
        const appLevel = await waitFor(
            'app.on(render-process-gone) to report it',
            async () => shellLines(/renderer process gone:/).length > 0,
            20_000
        ).then(() => true, () => false);
        check(
            '`app.on(render-process-gone)` names the dead process app-wide',
            appLevel,
            shellLines(/renderer process gone:/).at(-1) ?? ''
        );

        // ── 3. it rebuilds itself, once, with no user action ───────────────────────
        const rebuilt = await waitForAttach(paneID, mark, 30_000, 'the automatic rebuild');
        check(
            'a fresh view is built and placed with no user action (owner=main, attached)',
            rebuilt !== null,
            rebuilt === null ? 'ISSUE #76: the pane is still dead' : `${String(rebuilt.at - crashAt)} ms after the crash`
        );
        check(
            'it lands in the same box the dead one occupied',
            rebuilt !== null && rebuilt.bounds === healthyBounds,
            `${healthyBounds} → ${String(rebuilt?.bounds)}`
        );
        const afterOne = await waitFor(
            'the rebuilt page to answer a read',
            async () => (await pageAlive('after the rebuild')).ok,
            30_000
        ).then(() => true, () => false);
        check('the page is back at its URL, by itself', afterOne, (await pageAlive('after the rebuild')).detail);
        check('no card for a pane that recovered on its own', !(await cardUp()));

        // ── 4. a second crash inside the window stops, and says so ─────────────────
        mark = sinceIndex();
        await crashPane();
        const cardShown = await waitFor(
            'the client to draw the stopped-responding card',
            cardUp,
            30_000
        ).then(() => true, () => false);
        check('a repeat crash draws “This page stopped responding”', cardShown, await cardText(page, paneID));
        // The loop guard: no second automatic rebuild. Generous, because a wrong rebuild would
        // happen within a frame of the crash and this is seconds of grace on top.
        await sleep(4_000);
        const looped = placements
            .slice(mark)
            .filter((entry) => entry.paneID === paneID && entry.owner === 'main' && entry.reason === 'attached');
        check(
            'a page that crashes twice is NOT rebuilt again automatically',
            looped.length === 0,
            looped.length === 0 ? 'no second rebuild' : JSON.stringify(looped)
        );
        check('the tab is reported as not live', await tabIsDead(cli, paneID), await tabsJSON(cli, paneID));
        check('the chrome is still drawn around the card', await chromeUp(page, paneID));

        // ── 5. `kelpi web reload` brings it back rather than refusing ──────────────
        mark = sinceIndex();
        const reload = await cli.run(['web', 'reload', '--target', paneID], { timeoutMs: 30_000 });
        check(
            '`kelpi web reload` on a dead pane succeeds instead of `no live tab`',
            reload.code === 0 && !/no live tab/.test(reload.stdout + reload.stderr),
            `${reload.stdout.trim()}${reload.stderr.trim() === '' ? '' : ` [stderr: ${reload.stderr.trim()}]`}`
        );
        const backByCLI = await waitForAttach(paneID, mark, 30_000, 'the CLI-driven rebuild');
        check('and the view comes back (owner=main, attached)', backByCLI !== null, backByCLI?.bounds ?? '');
        const afterCLI = await waitFor(
            'the page to answer a read after the CLI reload',
            async () => (await pageAlive('after the CLI reload')).ok,
            30_000
        ).then(() => true, () => false);
        check('the page is back at its URL', afterCLI, (await pageAlive('after the CLI reload')).detail);
        check('the card is gone once the page is back', !(await cardUp()));

        // ── 6. …and so does the card's own Reload button ───────────────────────────
        mark = sinceIndex();
        await crashPane();
        const cardAgain = await waitFor('the card again', cardUp, 30_000).then(() => true, () => false);
        check('a third crash inside the window draws the card again', cardAgain);
        const clicked = await page.eval(
            `(() => {
                const button = document.querySelector('[data-testid="web-crashed-reload-${paneID}"]');
                if (button === null) return false;
                button.click();
                return true;
            })()`
        );
        check('the card carries a Reload button, and it clicks', clicked === true);
        const backByCard = await waitForAttach(paneID, mark, 30_000, 'the card-driven rebuild');
        check(
            'clicking Reload rebuilds the pane (owner=main, attached)',
            backByCard !== null,
            backByCard === null ? 'ISSUE #76: “no retry / reload option either”' : String(backByCard.bounds)
        );
        const afterCard = await waitFor(
            'the page to answer a read after the card reload',
            async () => (await pageAlive('after the card reload')).ok,
            30_000
        ).then(() => true, () => false);
        check('the page is back at its URL', afterCard, (await pageAlive('after the card reload')).detail);
        check('and the card takes itself down', !(await cardUp()));

        if (options.verbose) for (const entry of placements) log(`    ${JSON.stringify(entry)}`);
    } finally {
        try {
            site.server.close();
        } catch {
            /* already closed */
        }
        try {
            harness?.close();
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

async function cardText(page, paneID) {
    const text = await page.eval(
        `(document.querySelector('[data-testid="web-crashed-${paneID}"]')?.innerText ?? '').replace(/\\s+/g, ' ')`
    );
    return typeof text === 'string' ? text.trim() : '';
}

/** The chrome the user says is "still drawn": the URL bar and the pane's page hole. */
async function chromeUp(page, paneID) {
    return (
        (await page.eval(
            `document.querySelector('[data-testid="web-url-${paneID}"]') !== null &&
             document.querySelector('[data-testid="web-page-${paneID}"]') !== null`
        )) === true
    );
}

async function tabsJSON(cli, paneID) {
    const listed = await cli.run(['web', 'tabs', '--target', paneID, '--json'], { timeoutMs: 30_000 });
    return listed.stdout.trim();
}

async function tabIsDead(cli, paneID) {
    return /"live"\s*:\s*false/.test(await tabsJSON(cli, paneID));
}

main().catch((error) => {
    log(`\nharness error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 1;
});
