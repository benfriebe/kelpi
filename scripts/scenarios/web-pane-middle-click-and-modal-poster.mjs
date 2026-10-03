/**
 * Three web-pane requests, one fixture page:
 *
 *   1. "middle clicking in a browser pane should open a new tab in the browser". A middle-click
 *      on a link reaches Chromium as a `background-tab` window-open, and the shell used to deny
 *      every window-open outright, so the click did nothing.
 *   2. "when something is rendering over the top of a browser tab (update dialog, settings,
 *      workspace notification) the browser pane doesn't render its content, but closing the
 *      dialog brings it back". A whole-window modal parked every page with no poster, so the
 *      pane was an empty hole for as long as the modal was up.
 *   3. "middle clicking on a tab to close the tab": the tab strip's pill, as in every browser.
 *
 * The instruments are the daemon's tab list (`kelpi web tabs --json`), the shell's placement line
 * (`view owner=main|holder`), and the poster `<img>` in the pane's hole. The middle-click is
 * dispatched over CDP straight into the page's own target, which is the only way to put a press
 * inside a native `WebContentsView`.
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, listTargets } from '../ui-audit/lib/cdp.mjs';

export const covers = [
    'packages/shell/src/webhost/tab.ts',
    'packages/shell/src/webhost/window-open.ts',
    'packages/shell/src/webhost/index.ts',
    'packages/daemon/src/webpane/service.ts',
    'packages/client/src/webpane/WebPageSurface.tsx',
    'packages/client/src/webpane/WebPane.tsx',
    'packages/client/src/App.tsx'
];

/** CDP has to deliver a press into the native view, which an occluded window drops (#206). */
export const windowPlacement = 'offscreen';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const PLACEMENT = /web pane ([0-9A-Fa-f-]{36}) view owner=(main|holder) bounds=(\S+ \S+|-) \(([^)]*)\)/;

function ownerOf(shell, paneID) {
    let latest = null;
    for (const line of shell.lines) {
        const match = PLACEMENT.exec(line);
        if (match === null || match[1] !== paneID) continue;
        latest = { owner: match[2], bounds: match[3], reason: match[4] };
    }
    return latest;
}

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Middle Click Fixture</title>
<style>html,body{margin:0;background:#1d6b4f;color:#fff;font:16px/1.5 system-ui}
a{display:block;margin:40px;padding:20px;background:#fff;color:#000;font-size:20px}</style></head>
<body><a id="link" href="/second">second page</a><p style="margin:40px">fixture</p></body></html>`;
const SECOND = `<!doctype html><html><head><meta charset="utf-8"><title>Second Page</title></head>
<body style="background:#6b1d4f;color:#fff">second</body></html>`;

export default async function ({ page, cli, shell, rec, d, sleep, sandbox }) {
    if (shell === null || sandbox === undefined) {
        rec.check('this scenario needs the sandbox this runner boots', false, 'run it without --attach');
        return;
    }

    const server = http.createServer((request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(request.url === '/second' ? SECOND : FIXTURE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${String(server.address().port)}`;
    const fixtureURL = `${base}/`;

    let paneID = null;
    let native = null;
    try {
        const opened = await cli.ok(['web', 'open', fixtureURL]);
        paneID = (/open ok:\s*([0-9a-f-]{36})/i.exec(opened) ?? [])[1] ?? null;
        rec.check('a web pane opened on the fixture', paneID !== null, opened.trim());
        if (paneID === null) return;
        const placed = await d.settle(() => ownerOf(shell, paneID)?.owner === 'main', { ceilingMs: 20_000, intervalMs: 50 });
        rec.check('its view is in the shell window', placed, JSON.stringify(ownerOf(shell, paneID)));
        if (!placed) return;

        // ── 2 · a whole-window modal over a live page ─────────────────────────────────────
        // Settled first: a poster is a photograph, and a page still loading photographs blank.
        await sleep(1500);
        const poster = `[data-testid="web-poster-${paneID}"]`;
        const posterState = async () =>
            JSON.parse(
                String(
                    await page.eval(`(() => {
                        const img = document.querySelector('${poster}');
                        if (img === null) return 'null';
                        const r = img.getBoundingClientRect();
                        return JSON.stringify({ complete: img.complete, natural: img.naturalWidth, w: r.width, h: r.height });
                    })()`)
                )
            );

        await d.openSettingsRoot(page);
        const settingsUp = (await page.eval(`document.querySelector('${d.PAGE.settingsPanel}') !== null`)) === true;
        rec.check('Settings opened over the web pane', settingsUp);
        const parkedForSettings = await d.settle(() => ownerOf(shell, paneID)?.owner === 'holder', { ceilingMs: 5_000, intervalMs: 50 });
        rec.check('the live page steps aside for the Settings modal', parkedForSettings, JSON.stringify(ownerOf(shell, paneID)));
        const posterUnderSettings = await d.settle(
            async () => {
                const state = await posterState();
                return state !== null && state.complete && state.natural > 0 && state.w > 0 && state.h > 0;
            },
            { ceilingMs: 5_000, intervalMs: 50 }
        );
        rec.check(
            'the pane shows a still frame of its page under Settings instead of an empty hole',
            posterUnderSettings,
            JSON.stringify(await posterState())
        );
        await rec.shot(page, 'settings-over-web-pane');

        await page.key('Escape');
        const settingsGone = await d.settle(
            async () => (await page.eval(`document.querySelector('${d.PAGE.settingsPanel}') === null`)) === true,
            { ceilingMs: 5_000 }
        );
        rec.check('Escape closes Settings', settingsGone);
        const backAfterSettings = await d.settle(() => ownerOf(shell, paneID)?.owner === 'main', { ceilingMs: 5_000, intervalMs: 50 });
        rec.check('the live page comes back when Settings closes', backAfterSettings, JSON.stringify(ownerOf(shell, paneID)));
        const posterCleared = await d.settle(async () => (await posterState()) === null, { ceilingMs: 5_000, intervalMs: 100 });
        rec.check('and the still frame is taken down after it', posterCleared);

        // The floating-surface path, the control: a menu over the page has always postered.
        await sleep(600);
        await page.rightClick(`[data-testid="pane-header-${paneID}"]`);
        const menuUp = await d.settleDom(page, `document.querySelector('${d.PAGE.contextMenu}')`, { ceilingMs: 3_000 });
        rec.check('a pane-header context menu opened', menuUp);
        const posterUnderMenu = await d.settle(
            async () => {
                const state = await posterState();
                return state !== null && state.complete && state.natural > 0;
            },
            { ceilingMs: 5_000, intervalMs: 50 }
        );
        rec.check('a menu over the page still gets a still frame', posterUnderMenu, JSON.stringify(await posterState()));
        await page.key('Escape');
        await d.settle(() => ownerOf(shell, paneID)?.owner === 'main', { ceilingMs: 5_000, intervalMs: 50 });

        // ── 1 · middle-click a link inside the page ───────────────────────────────────────
        let found = null;
        await d.settle(
            async () => {
                found = (await listTargets(sandbox.debugPort)).find((target) => target.type === 'page' && target.url === fixtureURL) ?? null;
                return found !== null;
            },
            { ceilingMs: 10_000 }
        );
        rec.check('the page has its own CDP target', found !== null);
        if (found === null) return;
        native = await connect(found.webSocketDebuggerUrl, { repoRoot });
        const link = JSON.parse(
            String(
                await native.eval(`(() => {
                    const r = document.getElementById('link').getBoundingClientRect();
                    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
                })()`)
            )
        );
        await native.clickAt(link.x, link.y, { button: 'middle' });

        const tabs = async () => JSON.parse((await cli.run(['web', 'tabs', '--target', paneID, '--json'])).stdout);
        let after = [];
        const opened2 = await d.settle(
            async () => {
                after = await tabs();
                return after.length === 2;
            },
            { ceilingMs: 8_000, intervalMs: 100 }
        );
        rec.check('a middle-click on a link opens a second tab in the pane', opened2, JSON.stringify(after));
        const added = after.find((tab) => tab.url !== fixtureURL) ?? null;
        rec.check('the new tab is the link target', added?.url === `${base}/second`, JSON.stringify(added));
        rec.check(
            'it opens in the background, like a browser: the clicked page stays active',
            after.find((tab) => tab.active === true)?.url === fixtureURL,
            JSON.stringify(after)
        );
        rec.check(
            'the clicked page did not navigate away',
            (await native.eval('location.href')) === fixtureURL
        );
        const tabStrip = await d.settle(
            async () => (await page.eval(`document.querySelectorAll('[data-testid="web-tabs-${paneID}"] [data-testid^="web-tab-select-"]').length`)) >= 2,
            { ceilingMs: 5_000 }
        );
        rec.check('the pane draws the second tab in its tab strip', tabStrip);
        await rec.shot(page, 'after-middle-click');

        // ── 3 · middle-click a tab in the strip closes it ─────────────────────────────────
        if (added !== null) {
            const pill = await page.box(`[data-testid="web-tab-${added.id}"]`);
            await page.clickAt(pill.cx, pill.cy, { button: 'middle' });
            let remaining = [];
            const closed = await d.settle(
                async () => {
                    remaining = await tabs();
                    return remaining.length === 1;
                },
                { ceilingMs: 8_000, intervalMs: 100 }
            );
            rec.check('a middle-click on a tab in the strip closes it', closed, JSON.stringify(remaining));
            rec.check('and leaves the other tab', remaining[0]?.url === fixtureURL, JSON.stringify(remaining));
        }
        for (const line of shell.lines.filter((line) => /window\.open|asking for a (fore|back)ground tab/.test(line))) rec.note(line.trim());
    } finally {
        native?.close();
        if (paneID !== null) await cli.run(['pane', 'close', '--target', paneID]);
        server.close();
    }
}
