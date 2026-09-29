/**
 * #286: the update flow, end to end, in the Kelpi window.
 *
 * The report: after Update Now nothing visible happened, a second Check for Updates said it was
 * checking, and then the window closed on its own (the old code quit into the update the moment
 * the download finished). This drives the replacement through every state and photographs each:
 *
 *   up to date → a blocked offer (running from an App-Translocated copy) → an offer with markdown
 *   release notes → downloading → "still downloading" when it takes longer than expected → a second
 *   check shows the download, not "checking" → the download fails → Retry → ready (and NOTHING
 *   quits) → Later keeps it ready → a second check shows ready → the native fallback, parented to
 *   the window, when the page does not answer, with the page's sheet closed so only one surface
 *   asks → a restart whose install FAILS: the app stays usable, the quit gate is re-armed and the
 *   sheet offers Quit → Restart Now lets the quit through the quit gate, the shell exits, and the
 *   sandbox daemon keeps running.
 *
 * What is real: the page, the daemon relay (`update-state` / `update-action`), the shell's update
 * flow and surface, the feed check (an HTTP request to a local stand-in for update.electronjs.org
 * started here), the quit gate and the quit. What is not: Squirrel. A development shell cannot
 * update, so the harness's test-only seam (`packages/shell/src/update-audit.ts`, dormant unless
 * `KELPI_AUDIT_UPDATER`'s file exists, and ignored by a packaged app) stands in for `autoUpdater`:
 * it "downloads" until the control file says done or fail, and its `quitAndInstall` quits the
 * shell WITHOUT installing anything. Nothing here touches an installed Kelpi.
 *
 * Run it on its own, last in any batch: it ends by quitting its shell.
 */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const covers = [
    'packages/shell/src/update-flow.ts',
    'packages/shell/src/update-surface.ts',
    'packages/shell/src/update-audit.ts',
    'packages/shell/src/updater.ts',
    'packages/shell/src/main.ts',
    'packages/shell/src/status.ts',
    'packages/shell/src/menu.ts',
    'packages/daemon/src/ws/sync.ts',
    'packages/daemon/src/ws/desktop.ts',
    'packages/daemon/src/content/markdown.ts',
    'packages/client/src/chrome/UpdateSheet.tsx',
    'packages/client/src/chrome/release-notes.tsx',
    'packages/client/src/app/update-sheet.ts',
    'packages/client/src/App.tsx'
];

/** Real screenshots are the evidence here, so never the hidden lane. */
export const windowPlacement = 'offscreen';

const OFFERED = '0.9.0';
const RELEASE_URL = `https://github.com/benfriebe/kelpi/releases/tag/v${OFFERED}`;
const NOTES = [
    `## What's new in ${OFFERED}`,
    '',
    '- **Updates in the window**: the whole flow is a sheet centred on Kelpi, with release notes like these.',
    '- `Restart Now` happens only when you choose it; `Later` installs the update the next time you quit.',
    '',
    '### Fixes',
    '',
    '1. A second *Check for Updates* shows the download instead of saying it is checking.',
    '2. Kelpi says so when it runs from a disk image or a translocated copy.',
    '',
    '```sh',
    'kelpi --version',
    '```',
    '',
    `Full notes: [the release page](${RELEASE_URL}).`,
    '',
    '<script>window.__kelpiNotesRan = true</script>'
].join('\n');

const SHEET = '[data-testid="update-sheet"]';

export default async function ({ page, sandbox, shell, harness, daemon, rec, d, sleep }) {
    if (sandbox === undefined || sandbox === null || shell === null || shell === undefined) {
        rec.check('this scenario boots its own sandbox (the updater seam is set on the shell it launches)', false, 'run without --attach');
        return;
    }

    // ── a local stand-in for update.electronjs.org ─────────────────────────────────────────
    let feedMode = 'none';
    const feedRequests = [];
    const server = http.createServer((request, response) => {
        feedRequests.push(request.url ?? '');
        if (feedMode === 'none') {
            response.writeHead(204);
            response.end();
            return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
            JSON.stringify({
                name: `Kelpi ${OFFERED}`,
                notes: NOTES,
                url: `https://github.com/benfriebe/kelpi/releases/download/v${OFFERED}/Kelpi-darwin-arm64-${OFFERED}.zip`
            })
        );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const feed = `http://127.0.0.1:${String(server.address().port)}`;
    rec.note(`fake feed: ${feed}`);
    // ~/Applications need not exist: the location check only asks whether its parent is writable,
    // and never looks at (let alone touches) /Applications/Kelpi.app.
    const inApplications = path.join(os.homedir(), 'Applications', 'Kelpi.app');
    const control = (fields = {}) => d.scriptUpdater(sandbox, { feed, bundlePath: inApplications, download: 'pending', ...fields });

    const sheet = async () =>
        JSON.parse(
            String(
                await page.eval(`(() => {
                    const el = document.querySelector('${SHEET}');
                    if (el === null) return 'null';
                    const r = el.getBoundingClientRect();
                    const text = (id) => document.querySelector('[data-testid="' + id + '"]')?.textContent ?? null;
                    return JSON.stringify({
                        phase: el.getAttribute('data-phase'),
                        title: text('update-title'),
                        subtitle: text('update-subtitle'),
                        message: text('update-message'),
                        location: text('update-location'),
                        centreDX: Math.round((r.left + r.width / 2) - window.innerWidth / 2),
                        centreDY: Math.round((r.top + r.height / 2) - window.innerHeight / 2),
                        buttons: Array.from(el.querySelectorAll('button')).map((b) => b.getAttribute('data-testid'))
                    });
                })()`)
            )
        );
    const waitPhase = (phase, ceilingMs = 10_000) =>
        d.settleDom(page, `document.querySelector('${SHEET}')?.getAttribute('data-phase') === ${JSON.stringify(phase)}`, { ceilingMs });
    const waitClosed = () => d.settleDom(page, `document.querySelector('${SHEET}') === null`, { ceilingMs: 5_000 });
    const updateRow = async () => {
        const menu = await harness.menu();
        const kelpi = (Array.isArray(menu) ? menu : menu.items ?? []).find((item) => item.label === 'Kelpi');
        const row = kelpi?.submenu?.[1];
        return row === undefined ? null : { label: row.label, enabled: row.enabled };
    };
    const menuCheck = async () => {
        const row = await updateRow();
        await harness.menuClick({ path: ['Kelpi', row?.label ?? 'Check for Updates…'] });
    };
    const titlebarCheck = async () => {
        await page.click(d.PAGE.titlebarMenuToggle);
        await d.clickMenuItem(page, 'Check for Updates…');
    };
    const logSince = (mark) => shell.lines.slice(mark).map(String);
    const centred = (state) => Math.abs(state.centreDX) <= 2 && Math.abs(state.centreDY) <= 2;

    try {
        // ── 0. dormant: the development shell before the seam is written ──────────────────
        const before = await updateRow();
        rec.check('before the seam is written, the menu row is the development build\'s greyed "Check for Updates…"', before?.label === 'Check for Updates…' && before?.enabled === false, JSON.stringify(before));

        // ── 1. up to date, from the ••• menu ─────────────────────────────────────────────
        control();
        feedMode = 'none';
        await titlebarCheck();
        rec.check('a manual check with nothing newer shows "up to date" in the window', await waitPhase('up-to-date'), JSON.stringify(await sheet()));
        const upToDate = await sheet();
        rec.check('the sheet names the running version', /is the latest version\.$/.test(upToDate.subtitle ?? ''), JSON.stringify(upToDate));
        rec.check('the sheet is centred in the window (within 2 px both ways)', centred(upToDate), JSON.stringify(upToDate));
        rec.check('the check read the feed for this build\'s platform and version', feedRequests.at(-1)?.startsWith('/benfriebe/kelpi/darwin-') === true, feedRequests.at(-1));
        await rec.shot(page, 'up-to-date');
        await page.click('[data-testid="update-ok"]');
        rec.check('OK closes it', await waitClosed());
        const enabledRow = await updateRow();
        rec.check('the menu row is live once the flow has run', enabledRow?.label === 'Check for Updates…' && enabledRow?.enabled === true, JSON.stringify(enabledRow));

        // ── 2. an offer Kelpi cannot install from where it runs ───────────────────────────
        feedMode = 'offer';
        control({ bundlePath: '/private/var/folders/zz/T/AppTranslocation/0A1B2C3D/d/Kelpi.app' });
        await menuCheck();
        rec.check('an offer from a translocated copy is shown', await waitPhase('available'), JSON.stringify(await sheet()));
        const blocked = await sheet();
        rec.check('it says why it cannot install and how to fix it', /App Translocation/.test(blocked.location ?? '') && /Applications/.test(blocked.location ?? ''), JSON.stringify(blocked));
        rec.check('and offers no Update Now', !blocked.buttons.includes('update-now') && blocked.buttons.includes('update-ok'), JSON.stringify(blocked.buttons));
        await rec.shot(page, 'blocked-running-outside-applications');
        await page.click('[data-testid="update-ok"]');
        await waitClosed();

        // ── 3. the offer, with markdown release notes ──────────────────────────────────────
        control();
        await menuCheck();
        rec.check('Check for Updates… offers the new version in the window', await waitPhase('available'), JSON.stringify(await sheet()));
        const offer = await sheet();
        rec.check('the offer names the new version', offer.title === `Kelpi ${OFFERED} is available`, offer.title);
        rec.check('the offer sheet is centred in the window', centred(offer), JSON.stringify(offer));
        const notes = JSON.parse(
            String(
                await page.eval(`(() => {
                    const n = document.querySelector('[data-testid="update-notes"]');
                    return JSON.stringify({
                        h2: n?.querySelector('h2')?.textContent ?? null,
                        h3: n?.querySelector('h3')?.textContent ?? null,
                        bullets: n?.querySelectorAll('ul > li').length ?? 0,
                        numbered: n?.querySelectorAll('ol > li').length ?? 0,
                        inlineCode: n?.querySelector('li code')?.textContent ?? null,
                        block: n?.querySelector('pre code')?.textContent ?? null,
                        link: n?.querySelector('a')?.getAttribute('href') ?? null,
                        scripts: document.querySelectorAll('${SHEET} script').length,
                        ran: window.__kelpiNotesRan === true,
                        escapedText: (n?.textContent ?? '').includes('<script>window.__kelpiNotesRan = true</script>')
                    });
                })()`)
            )
        );
        rec.check('the notes render as markdown: headings, both kinds of list, inline and block code, a link', notes.h2 === `What's new in ${OFFERED}` && notes.h3 === 'Fixes' && notes.bullets === 2 && notes.numbered === 2 && notes.inlineCode === 'Restart Now' && notes.block === 'kelpi --version\n' && notes.link === RELEASE_URL, JSON.stringify(notes));
        rec.check('raw HTML in the notes is shown as text and never runs', notes.scripts === 0 && notes.ran === false && notes.escapedText, JSON.stringify(notes));
        await rec.shot(page, 'available-with-release-notes');
        const opensBefore = (await harness.counters()).externalOpens;
        await page.eval(`document.querySelector('[data-testid="update-notes"] a')?.click()`);
        const opened = await d.settle(async () => (await harness.counters()).externalOpens > opensBefore, { ceilingMs: 5_000 });
        rec.check('a release-note link opens in the system browser, not the window', opened && (await harness.counters()).lastExternalUrl === RELEASE_URL, JSON.stringify(await harness.counters()));

        // ── 4. Update Now: downloading, visibly ────────────────────────────────────────────
        // "Taking longer than expected" after 2.5 s instead of ten minutes, so it can be shown.
        control({ slowAfterMs: 2500 });
        await page.click('[data-testid="update-now"]');
        rec.check('Update Now shows the download in progress', await waitPhase('downloading'), JSON.stringify(await sheet()));
        const downloading = await sheet();
        rec.check('it promises to ask before restarting', /Kelpi will ask before it restarts/.test(downloading.subtitle ?? ''), JSON.stringify(downloading));
        rec.check('with an indeterminate progress bar', (await page.eval(`(() => { const b = document.querySelector('[data-testid="update-progress"]'); return b !== null && b.getAttribute('aria-valuenow') === null; })()`)) === true);
        await rec.shot(page, 'downloading');
        const downloadingRow = await updateRow();
        rec.check('the menu row says it is downloading', downloadingRow?.label === `Downloading Kelpi ${OFFERED}…`, JSON.stringify(downloadingRow));
        rec.note(`menu while downloading: Kelpi ▸ ${String(downloadingRow?.label)}`);
        const slow = await d.settleDom(page, `(document.querySelector('[data-testid="update-subtitle"]')?.textContent ?? '').includes('taking longer than expected')`, { ceilingMs: 8_000 });
        const stillDownloading = await sheet();
        rec.check('a slow download says it is still going, and is not a failure', slow && stillDownloading.phase === 'downloading', JSON.stringify(stillDownloading));
        await rec.shot(page, 'still-downloading');

        // ── 5. a second check during the download shows the download, not "checking" ──────
        await page.click('[data-testid="update-hide"]');
        await waitClosed();
        const feedBefore = feedRequests.length;
        const mark = shell.lines.length;
        await menuCheck();
        rec.check('a second Check for Updates shows the download again', await waitPhase('downloading'), JSON.stringify(await sheet()));
        rec.check('without reading the feed again or saying "checking"', feedRequests.length === feedBefore && !logSince(mark).some((line) => line.includes('-> checking')), logSince(mark).filter((line) => line.includes('auto-update')).join(' | '));

        // ── 6. the download fails, readably, and Retry recovers ────────────────────────────
        control({ download: 'fail:The network connection was lost.' });
        rec.check('a failed download says what went wrong', await waitPhase('failed'), JSON.stringify(await sheet()));
        const failed = await sheet();
        rec.check('with the reason and Retry', failed.title === `Kelpi ${OFFERED} could not be downloaded` && failed.message === 'The network connection was lost.' && failed.buttons.includes('update-retry'), JSON.stringify(failed));
        await rec.shot(page, 'download-failed');
        control({ download: 'pending' });
        await page.click('[data-testid="update-retry"]');
        rec.check('Retry downloads again', await waitPhase('downloading'), JSON.stringify(await sheet()));

        // ── 7. ready: the download ENDS in a question, and nothing quits ───────────────────
        const readyMark = shell.lines.length;
        control({ download: 'done' });
        rec.check('a finished download asks: "Kelpi X is ready"', await waitPhase('ready'), JSON.stringify(await sheet()));
        const ready = await sheet();
        rec.check('Restart Now and Later, and Kelpi reopens by itself', ready.title === `Kelpi ${OFFERED} is ready` && /reopens by itself/.test(ready.subtitle ?? '') && ready.buttons.includes('update-restart') && ready.buttons.includes('update-later'), JSON.stringify(ready));
        await sleep(1500);
        rec.check('nothing quit or installed when the download finished (#286)', !shell.exited && !logSince(readyMark).some((line) => line.includes('quitAndInstall called') || line.includes('quit: allowed')), logSince(readyMark).filter((line) => line.includes('auto-update') || line.includes('quit')).join(' | '));
        await rec.shot(page, 'ready-to-restart');

        // ── 8. Later keeps it ready, and the menu offers the restart ──────────────────────
        await page.click('[data-testid="update-later"]');
        await waitClosed();
        const readyRow = await updateRow();
        rec.check('after Later the menu row offers the restart', readyRow?.label === `Restart to Update to Kelpi ${OFFERED}…` && readyRow?.enabled === true, JSON.stringify(readyRow));
        rec.note(`menu after Later: Kelpi ▸ ${String(readyRow?.label)}`);
        rec.check('and the log says it installs on the next quit', shell.lines.map(String).some((line) => line.includes(`${OFFERED} installs when Kelpi next quits`)));
        await menuCheck();
        rec.check('the row shows the ready sheet again', await waitPhase('ready'), JSON.stringify(await sheet()));
        await page.click('[data-testid="update-later"]');
        await waitClosed();

        // ── 9. the native fallback, parented to the window, when the page does not answer ──
        // The page's `shown` acknowledgement is dropped on the way out (a page that cannot draw the
        // sheet), so the shell falls back to a native dialog, answered here as Later.
        await page.eval(`(() => {
            const send = WebSocket.prototype.send;
            window.__kelpiRestoreSend = () => { WebSocket.prototype.send = send; };
            WebSocket.prototype.send = function (data) {
                if (typeof data === 'string' && data.includes('"update_action":"shown"')) return;
                return send.call(this, data);
            };
        })()`);
        const dialogsBefore = (await harness.counters()).dialogs;
        await harness.armDialog({ response: 1 });
        await menuCheck();
        const fellBack = await d.settle(async () => (await harness.counters()).dialogs > dialogsBefore, { ceilingMs: 8_000 });
        const native = (await harness.counters()).lastDialog;
        await page.eval(`window.__kelpiRestoreSend?.()`);
        rec.check('with no acknowledgement the shell shows the native dialog instead', fellBack, JSON.stringify(native));
        rec.check('parented to the Kelpi window (a sheet centred on it), asking Restart Now / Later', native?.parented === true && native?.message === `Kelpi ${OFFERED} is ready` && JSON.stringify(native?.buttons) === JSON.stringify(['Restart Now', 'Later']), JSON.stringify(native));
        rec.check('and the page closed its own sheet, so only one surface asks', await waitClosed());

        // ── 10. a restart whose install fails: usable app, re-armed gate, Quit offered ───────
        control({ download: 'done', install: 'fail:ShipIt could not replace the app.' });
        const failMark = shell.lines.length;
        await menuCheck();
        await waitPhase('ready');
        await page.click('[data-testid="update-restart"]');
        rec.check('a failed install is shown in the window', await waitPhase('failed'), JSON.stringify(await sheet()));
        const installFailed = await sheet();
        rec.check(
            'it says to quit and reopen, gives the reason, and offers Quit Kelpi instead of Retry',
            installFailed.title === 'Kelpi could not finish installing the update' &&
                /Quit Kelpi and open it again/.test(installFailed.subtitle ?? '') &&
                installFailed.message === 'ShipIt could not replace the app.' &&
                installFailed.buttons.includes('update-quit') &&
                !installFailed.buttons.includes('update-retry'),
            JSON.stringify(installFailed)
        );
        const failLog = logSince(failMark);
        rec.check(
            'the quit gate was opened, then re-armed, and nothing was torn down (the sheet arrived over the status connection)',
            failLog.some((line) => line.includes('quit: allowed for an update')) &&
                failLog.some((line) => line.includes('quit confirmation applies again')) &&
                !shell.exited,
            failLog.filter((line) => line.includes('quit') || line.includes('install')).join(' | ')
        );
        await rec.shot(page, 'install-failed');
        await page.click('[data-testid="update-close"]');
        await waitClosed();
        const afterFailRow = await updateRow();
        rec.check('Close leaves Kelpi usable, with the plain Check for Updates… row', afterFailRow?.label === 'Check for Updates…' && afterFailRow?.enabled === true, JSON.stringify(afterFailRow));

        // ── 11. Restart Now: through the quit gate, the shell exits, the daemon stays ───────
        control({ download: 'done' });
        const pid = daemon?.pid;
        const restartMark = shell.lines.length;
        await menuCheck();
        await waitPhase('available');
        await page.click('[data-testid="update-now"]');
        await waitPhase('ready');
        await page.click('[data-testid="update-restart"]');
        const restarting = await waitPhase('restarting', 3_000);
        rec.check('Restart Now shows "Restarting…"', restarting, JSON.stringify(await sheet().catch(() => null)));
        if (restarting) await rec.shot(page, 'restarting');
        const quit = await d.settle(async () => shell.exited, { ceilingMs: 15_000 });
        const restartLog = logSince(restartMark);
        const allowed = restartLog.findIndex((line) => line.includes('quit: allowed for an update; leaving the daemon running'));
        const installed = restartLog.findIndex((line) => line.includes('audit installer: quitAndInstall called'));
        rec.check('the quit gate let the quit through before quitAndInstall ran', allowed >= 0 && installed > allowed, restartLog.filter((line) => line.includes('quit') || line.includes('auto-update')).join(' | '));
        rec.check('the shell quit', quit);
        let healthy = false;
        try {
            healthy = (await fetch(`${sandbox.base}/healthz`)).ok;
        } catch {
            healthy = false;
        }
        rec.check('and the daemon kept running (same process, still answering)', healthy && daemon?.pid === pid && daemon?.exited === false, `healthz ${String(healthy)} pid ${String(pid)} -> ${String(daemon?.pid)}`);
        rec.note(`updater log: ${shell.lines.map(String).filter((line) => line.includes('auto-update:')).slice(-30).join(' || ')}`);
    } finally {
        d.scriptUpdater(sandbox, null);
        server.close();
    }
}
