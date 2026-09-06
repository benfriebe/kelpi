/**
 * #76: a web pane whose renderer keeps dying says so, and offers a way back.
 *
 * The user's report was "sometimes web panes just go blank and only show the browser chrome, but
 * aren't rendering the body of the browser at all" and "no retry / reload option either". The
 * first half of the fix is invisible on purpose - a one-off renderer death rebuilds itself, and
 * the user just sees the page reload - so what a person can actually LOOK at is the second half:
 * a page that dies twice inside the rebuild window gets a card with a button on it.
 *
 * `scripts/ui-audit/web-view-rebuild.mjs` is the deep harness for the same issue and asserts the
 * shell's placement log. This one is the client's side, in the hidden lane: the card is ordinary
 * DOM in the page the shell loads, so it is one of the few things about a web pane that CAN be
 * asserted without pixels.
 */

import http from 'node:http';

/**
 * The source this presses. `WebPane.tsx` renders the card and wires its Reload to
 * `commands.reload`; `webpane/service.ts` is the half that decides a pane has died once too
 * often and marks its tab not-live, which is the only thing that puts the card on screen.
 */
export const covers = [
    'packages/client/src/webpane/WebPane.tsx',
    'packages/daemon/src/webpane/service.ts',
    'packages/daemon/src/webpane/handlers.ts'
];

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Crash Card Fixture</title>
<style>html,body{margin:0;background:#101014;color:#7ee787;font:28px/1.4 ui-monospace,monospace}
#t{padding:24px}</style></head><body><div id="t">starting…</div>
<script>
  let n = 0;
  setInterval(() => { n += 1; document.getElementById('t').textContent = 'tick ' + n; }, 100);
</script></body></html>`;

export default async function ({ page, cli, harness, rec, d }) {
    const site = await new Promise((resolve) => {
        const server = http.createServer((_request, response) => {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.end(FIXTURE);
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
    });

    try {
        const opened = await cli.run(['web', 'open', site.url], { timeoutMs: 60_000 });
        const paneID = (/open ok:\s*([0-9a-f-]{36})/i.exec(opened.stdout) ?? [])[1];
        rec.check('`kelpi web open` opened a web pane', paneID !== undefined, opened.stdout || opened.stderr);
        if (paneID === undefined) return;

        const card = `[data-testid="web-crashed-${paneID}"]`;
        const reload = `[data-testid="web-crashed-reload-${paneID}"]`;
        /** A read that needs a live page: `web url` falls back to daemon state, `web text` cannot. */
        const pageReads = async () => /tick \d+/.test((await cli.run(['web', 'text', '#t', '--target', paneID])).stdout);
        /**
         * Crash it, without letting a refusal end the run. Against a tree with the fix reverted
         * the pane is never rebuilt, so the second crash has nothing to kill and the op answers
         * `no live view` — and the checks after it are the ones that say what the bug is.
         */
        const crash = async () => {
            try {
                await harness.crash(paneID);
                return true;
            } catch (error) {
                rec.note(`crash refused: ${error instanceof Error ? error.message : String(error)}`);
                return false;
            }
        };

        await d.settleDom(page, `document.querySelector('[data-testid="web-page-${paneID}"]')`, { ceilingMs: 15_000 });
        rec.check(
            'the fixture is running before anything is crashed',
            await d.settle(pageReads, { ceilingMs: 20_000 }),
            site.url
        );
        rec.check('no card on a healthy pane', (await page.eval(`document.querySelector('${card}') === null`)) === true);

        // One death is a recovery, not a report: the daemon rebuilds the pane and the user sees
        // a reload. Waiting for the page to answer again is what proves that half happened.
        await crash();
        rec.check(
            'a single renderer death rebuilds itself, with no card',
            await d.settle(pageReads, { ceilingMs: 25_000 }),
            'the page answers a read again'
        );
        rec.check(
            'and still no card afterwards',
            (await page.eval(`document.querySelector('${card}') === null`)) === true
        );

        // The second death inside the window is the page's own fault, and the daemon stops.
        await crash();
        const shown = await d.settleDom(page, `document.querySelector('${card}')`, { ceilingMs: 25_000 });
        rec.check('a repeat crash raises the stopped-responding card', shown);
        await rec.shot(page, 'crashed-card');

        const text = await page.eval(
            `(document.querySelector('${card}')?.innerText ?? '').replace(/\\s+/g, ' ').trim()`
        );
        rec.note(`card: ${String(text)}`);
        rec.check('it says what happened', String(text).includes('This page stopped responding'));
        rec.check('it names the address', String(text).includes(site.url));

        // The chrome the report describes as "still drawn" is still drawn: that half was never
        // the bug, and a card that replaced the URL bar would be a different regression.
        rec.check(
            'the nav row and the page hole are still there around it',
            (await page.eval(
                `document.querySelector('[data-testid="web-url-${paneID}"]') !== null &&
                 document.querySelector('[data-testid="web-page-${paneID}"]') !== null`
            )) === true
        );

        const tabs = await cli.run(['web', 'tabs', '--target', paneID, '--json']);
        rec.check('`kelpi web tabs` reports the tab as not live', /"live"\s*:\s*false/.test(tabs.stdout), tabs.stdout.trim());

        // "no retry / reload option either" — the whole point of the card. Tolerant of a missing
        // button for the same reason `crash` is: a reverted tree has no card to click, and the
        // two checks below are what say so.
        const clicked = await page
            .eval(
                `(() => { const b = document.querySelector('${reload}'); if (b === null) return false; b.click(); return true; })()`
            )
            .catch(() => false);
        rec.check('the card carries a Reload button', clicked === true);
        rec.check(
            'clicking Reload brings the page back',
            await d.settle(pageReads, { ceilingMs: 25_000 }),
            'the page answers a read after Reload'
        );
        rec.check(
            'and the card takes itself down',
            await d.settle(async () => (await page.eval(`document.querySelector('${card}') === null`)) === true, {
                ceilingMs: 10_000
            })
        );
        await rec.shot(page, 'card-cleared');
    } finally {
        try {
            site.server.close();
        } catch {
            /* already closed */
        }
    }
}
