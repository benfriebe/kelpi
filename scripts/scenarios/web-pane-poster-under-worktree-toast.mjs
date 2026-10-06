/**
 * "when the worktree cleared popup shows in the bottom right if theres a web pane in the
 * workspace it just renders as gray. when dismissing the popup it renders the website as normal"
 *
 * The "Removed worktree" toast is a corner box over the page area, so a web pane under it parks
 * and wears a poster (a still frame of its page). A web pane that arrives on screen while the toast
 * is ALREADY up (a workspace switch with the toast showing) is covered from its very first
 * publish, and that publish asked the shell for a frame before it sent the placement that puts the
 * view on screen. The shell answered "the view is not on screen", and the pane parked with no frame
 * for the rest of the toast's life: an empty gray hole until the toast went. A sticky "Kept on
 * disk" toast made that hole last until it was dismissed.
 *
 * The path is the owner's: delete the active worktree workspace from the sidebar, the window lands
 * on its neighbour, and the workspace with the web pane is clicked while the toast is still up.
 *
 * Everything is real: a git repo under the sandbox root, `kelpi workspace create --worktree`, the
 * sidebar's Delete with its worktree list, the toast the delete's reply raises, the shell's poster
 * and placement log lines, and the poster `<img>` in the pane's hole.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const covers = [
    'packages/client/src/webpane/WebPageSurface.tsx',
    'packages/client/src/webpane/poster.ts',
    'packages/client/src/features/workspaces-actions.ts',
    'packages/client/src/App.tsx',
    'packages/shell/src/webhost/tab.ts'
];

/** The sidebar menu and the dialog need CDP input to reach the window (see `placement.mjs`). */
export const windowPlacement = 'offscreen';

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

const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'kelpi-scenario',
    GIT_AUTHOR_EMAIL: 'scenario@example.com',
    GIT_COMMITTER_NAME: 'kelpi-scenario',
    GIT_COMMITTER_EMAIL: 'scenario@example.com'
};

function git(cwd, ...args) {
    return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Toast Poster Fixture</title>
<style>html,body{margin:0;height:100%;background:#1d6b4f;color:#fff;font:24px/1.5 system-ui}</style></head>
<body><p style="margin:40px">the page under the toast</p></body></html>`;

export default async function ({ page, cli, shell, rec, d, sleep, sandbox }) {
    if (shell === null || sandbox === undefined || sandbox === null) {
        rec.check('this scenario needs the sandbox this runner boots', false, 'run it without --attach');
        return;
    }

    const server = http.createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(FIXTURE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const fixtureURL = `http://127.0.0.1:${String(server.address().port)}/`;

    const listed = JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const home = listed.find((workspace) => workspace.is_active)?.id ?? listed[0]?.id ?? null;
    rec.check('the sandbox has a workspace to come back to', home !== null, JSON.stringify(listed));
    if (home === null) return;

    let paneID = null;
    let worktreeWorkspace = null;
    let otherWorkspace = null;
    try {
        const opened = await cli.ok(['web', 'open', fixtureURL]);
        paneID = (/open ok:\s*([0-9a-f-]{36})/i.exec(opened) ?? [])[1] ?? null;
        rec.check('a web pane opened on the fixture', paneID !== null, opened.trim());
        if (paneID === null) return;
        const placed = await d.settle(() => ownerOf(shell, paneID)?.owner === 'main', { ceilingMs: 20_000, intervalMs: 50 });
        rec.check('its view is in the shell window', placed, JSON.stringify(ownerOf(shell, paneID)));
        if (!placed) return;
        // A poster is a photograph, and a page still loading photographs blank.
        await sleep(1500);

        // ── a worktree workspace to delete ─────────────────────────────────────────────────
        const root = fs.realpathSync(fs.mkdtempSync(path.join(sandbox.root, 'toast-poster-')));
        const repo = path.join(root, 'repo');
        fs.mkdirSync(repo);
        git(repo, 'init', '-q', '--initial-branch=main');
        fs.writeFileSync(path.join(repo, 'README.md'), '# toast poster\n');
        git(repo, 'add', '.');
        git(repo, 'commit', '-q', '-m', 'first');
        const created = JSON.parse(
            await cli.ok(['workspace', 'create', '--worktree', 'toast-poster', '--repo', repo, '--no-update-main', '--json'])
        );
        worktreeWorkspace = created.workspace_id ?? null;
        rec.check('a worktree workspace was created', worktreeWorkspace !== null, JSON.stringify(created));
        if (worktreeWorkspace === null) return;
        // Its neighbour in the sidebar, which is where deleting the active workspace lands.
        const plain = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'toast-poster-other', '--json']));
        otherWorkspace = plain.workspace_id ?? null;
        rec.check('a plain workspace to land on was created', otherWorkspace !== null, JSON.stringify(plain));
        if (otherWorkspace === null) return;

        const row = (id) => `[data-testid="workspace-row"][data-workspace-id="${id}"]`;
        await d.settleDom(page, `document.querySelector(${JSON.stringify(row(worktreeWorkspace))})`, { ceilingMs: 10_000 });
        await page.click(row(worktreeWorkspace));
        const away = await d.settle(() => ownerOf(shell, paneID)?.owner === 'holder', { ceilingMs: 5_000, intervalMs: 50 });
        rec.check('switching to the worktree workspace parks the web pane', away, JSON.stringify(ownerOf(shell, paneID)));

        // ── delete it from the sidebar, removing its worktree ──────────────────────────────
        const name = String(created.workspace_name ?? 'toast-poster');
        await d.openSidebarMenu(page, d.PAGE.workspaceRows, name);
        await d.clickMenuItem(page, 'Delete');
        const listed2 = await d.settleDom(
            page,
            `document.querySelector('[data-testid="worktree-cleanup-check"]')?.checked === true`,
            { ceilingMs: 10_000 }
        );
        rec.check('the delete dialog lists the worktree, ticked', listed2);
        await rec.shot(page, 'delete-dialog');
        await page.click('[data-testid="confirm-delete"]');

        const toastUp = await d.settleDom(
            page,
            `Array.from(document.querySelectorAll('[data-testid="toast-stack"] button')).some(el => (el.textContent ?? '').includes('Removed worktree'))`,
            { ceilingMs: 15_000, intervalMs: 25 }
        );
        rec.check('the "Removed worktree" toast is up', toastUp);
        if (!toastUp) return;

        // The window lands on the deleted workspace's neighbour, not on the web pane's.
        const pageSelector = `[data-testid="web-page-${paneID}"]`;
        const landedAway = (await page.eval(`document.querySelector('${pageSelector}') === null`)) === true;
        rec.check('the delete lands on another workspace, away from the web pane', landedAway);
        if (!landedAway) return;
        const linesArrive = shell.lines.length;
        await page.click(row(home));
        const arrived = await d.settleDom(page, `document.querySelector('${pageSelector}') !== null`, { ceilingMs: 3_000 });
        const stillUp = (await page.eval(`document.querySelector('[data-testid="toast-stack"]') !== null`)) === true;
        rec.check('the web pane arrives on screen while the toast is still up', arrived && stillUp, JSON.stringify({ arrived, stillUp }));

        const geometry = JSON.parse(
            String(
                await page.eval(`(() => {
                    const hole = document.querySelector('${pageSelector}')?.getBoundingClientRect();
                    const toast = document.querySelector('[data-testid="toast-stack"]')?.getBoundingClientRect();
                    if (!hole || !toast) return 'null';
                    const overlaps = toast.x < hole.x + hole.width && hole.x < toast.x + toast.width &&
                        toast.y < hole.y + hole.height && hole.y < toast.y + toast.height;
                    return JSON.stringify({ overlaps, covered: document.querySelector('${pageSelector}').dataset.overlayCovered });
                })()`)
            )
        );
        rec.check('the toast sits over the web pane', geometry?.overlaps === true, JSON.stringify(geometry));

        const posterState = async () =>
            JSON.parse(
                String(
                    await page.eval(`(() => {
                        const img = document.querySelector('[data-testid="web-poster-${paneID}"]');
                        if (img === null) return 'null';
                        const r = img.getBoundingClientRect();
                        return JSON.stringify({ complete: img.complete, natural: img.naturalWidth, w: r.width, h: r.height });
                    })()`)
                )
            );
        const postered = await d.settle(
            async () => {
                const state = await posterState();
                return state !== null && state.complete && state.natural > 0 && state.w > 0 && state.h > 0;
            },
            { ceilingMs: 3_000, intervalMs: 50 }
        );
        rec.check(
            'under the toast the pane shows a still frame of its page, not an empty hole',
            postered,
            JSON.stringify(await posterState())
        );
        await rec.shot(page, 'arrived-under-toast');
        const lines = shell.lines.slice(linesArrive).filter((line) => line.includes(paneID) && /poster/.test(line));
        for (const line of lines) rec.note(line.trim());
        rec.check(
            'the shell took a frame of the arriving pane rather than refusing one',
            lines.some((line) => /poster \d+ base64 bytes/.test(line)) && !lines.some((line) => /poster refused/.test(line)),
            JSON.stringify(lines)
        );

        // Dismissing the toast (or its expiry, if the run was slow) hands the live page back.
        if ((await page.eval(`document.querySelector('[data-testid="toast-stack"] button') !== null`)) === true) {
            await page.click('[data-testid="toast-stack"] button');
        }
        const live = await d.settle(() => ownerOf(shell, paneID)?.owner === 'main', { ceilingMs: 5_000, intervalMs: 50 });
        rec.check('dismissing the toast brings the live page back', live, JSON.stringify(ownerOf(shell, paneID)));
    } finally {
        if (paneID !== null) await cli.run(['pane', 'close', '--target', paneID]);
        if (worktreeWorkspace !== null) await cli.run(['workspace', 'delete', worktreeWorkspace, '--force']);
        if (otherWorkspace !== null) await cli.run(['workspace', 'delete', otherWorkspace, '--force']);
        server.close();
    }
}
