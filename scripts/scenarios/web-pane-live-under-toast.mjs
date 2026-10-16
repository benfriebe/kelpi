/**
 * "when kelpi raises the notifications in the bottom right for things like workspaces deleted
 * etc, it steals focus. example is you cannot scroll a web pane when that notification pops up"
 *
 * The toast stack used to be drawn in the client's document, UNDER a web pane's native page, so
 * every page it overlapped was parked for the toast's life: a still frame where the page was, a
 * wheel that scrolled nothing, and the keyboard taken out of the page. The shell now draws the
 * stack in its corner layer, a see-through view above the pages (`shell/src/corner-layer.ts`), and
 * the page under a toast stays live.
 *
 * Two rounds, both the owner's path:
 *
 *   1. In place: a web pane on screen, a worktree workspace deleted from the sidebar, the
 *      "Removed worktree" toast over the page. The page must stay in the window, with no still
 *      frame, while the toast is up; the toast must be drawn by the layer; and a click on the
 *      layer's card must dismiss it.
 *   2. Arriving: delete the ACTIVE worktree workspace, land on its neighbour, click back to the
 *      web pane's workspace with the toast still up (#358's path). The page arrives live.
 *
 * Everything is real: a git repo under the sandbox root, `kelpi workspace create --worktree`, the
 * sidebar's Delete with its worktree list, the toast the delete's reply raises, the shell's
 * placement log lines, and the layer's own document over CDP.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, listTargets } from '../ui-audit/lib/cdp.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const covers = [
    'packages/client/src/chrome/ToastStack.tsx',
    'packages/client/src/chrome/corner-layer.ts',
    'packages/client/src/overlay/CornerOverlay.tsx',
    'packages/client/src/webpane/WebPageSurface.tsx',
    'packages/client/src/features/workspaces-actions.ts',
    'packages/client/src/App.tsx',
    'packages/shell/src/corner-layer.ts',
    'packages/shell/src/corner-layer-view.ts',
    'packages/shell/src/webhost/index.ts'
];

/** The sidebar menu and the dialog need CDP input to reach the window (see `placement.mjs`). */
export const windowPlacement = 'offscreen';

const PLACEMENT = /web pane ([0-9A-Fa-f-]{36}) view owner=(main|holder) bounds=(\S+ \S+|-) \(([^)]*)\)/;

function placements(lines, paneID) {
    const found = [];
    for (const line of lines) {
        const match = PLACEMENT.exec(line);
        if (match === null || match[1] !== paneID) continue;
        found.push({ owner: match[2], bounds: match[3], reason: match[4] });
    }
    return found;
}

const ownerOf = (shell, paneID) => placements(shell.lines, paneID).at(-1) ?? null;

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

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Live Under Toast Fixture</title>
<style>html,body{margin:0;background:#1d6b4f;color:#fff;font:24px/1.5 system-ui}p{margin:40px}</style></head>
<body>${Array.from({ length: 80 }, (_, i) => `<p>line ${String(i)} of the page under the toast</p>`).join('')}</body></html>`;

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

    const row = (id) => `[data-testid="workspace-row"][data-workspace-id="${id}"]`;
    const pageSelector = (paneID) => `[data-testid="web-page-${paneID}"]`;
    const stackText = `(document.querySelector('[data-testid="toast-stack"]')?.textContent ?? '')`;

    let paneID = null;
    let layer = null;
    const cleanupWorkspaces = [];
    try {
        const opened = await cli.ok(['web', 'open', fixtureURL]);
        paneID = (/open ok:\s*([0-9a-f-]{36})/i.exec(opened) ?? [])[1] ?? null;
        rec.check('a web pane opened on the fixture', paneID !== null, opened.trim());
        if (paneID === null) return;
        const placed = await d.settle(() => ownerOf(shell, paneID)?.owner === 'main', { ceilingMs: 20_000, intervalMs: 50 });
        rec.check('its view is in the shell window', placed, JSON.stringify(ownerOf(shell, paneID)));
        if (!placed) return;

        const drawing = await d.settle(() => shell.lines.some((line) => line.includes('corner layer: drawing')), {
            ceilingMs: 15_000,
            intervalMs: 100
        });
        rec.check('the shell put up its corner layer for this window', drawing, shell.lines.filter((line) => line.includes('corner layer')).join(' | '));
        if (!drawing) return;

        const root = fs.realpathSync(fs.mkdtempSync(path.join(sandbox.root, 'live-under-toast-')));
        const repo = path.join(root, 'repo');
        fs.mkdirSync(repo);
        git(repo, 'init', '-q', '--initial-branch=main');
        fs.writeFileSync(path.join(repo, 'README.md'), '# live under toast\n');
        git(repo, 'add', '.');
        git(repo, 'commit', '-q', '-m', 'first');
        const worktree = async (name) => {
            const created = JSON.parse(
                await cli.ok(['workspace', 'create', '--worktree', name, '--repo', repo, '--no-update-main', '--json'])
            );
            if (created.workspace_id) cleanupWorkspaces.push(created.workspace_id);
            return created;
        };
        const deleteFromSidebar = async (name) => {
            await d.openSidebarMenu(page, d.PAGE.workspaceRows, name);
            await d.clickMenuItem(page, 'Delete');
            const listedWorktree = await d.settleDom(
                page,
                `document.querySelector('[data-testid="worktree-cleanup-check"]')?.checked === true`,
                { ceilingMs: 10_000 }
            );
            rec.check(`the delete dialog for ${name} lists its worktree, ticked`, listedWorktree);
            await page.click('[data-testid="confirm-delete"]');
            return d.settleDom(page, `${stackText}.includes('Removed worktree')`, { ceilingMs: 15_000, intervalMs: 25 });
        };
        const pageState = async () =>
            JSON.parse(
                String(
                    await page.eval(`(() => {
                        const hole = document.querySelector('${pageSelector(paneID)}');
                        if (hole === null) return 'null';
                        return JSON.stringify({
                            visible: hole.dataset.visible,
                            covered: hole.dataset.overlayCovered,
                            poster: document.querySelector('[data-testid="web-poster-${paneID}"]') !== null
                        });
                    })()`)
                )
            );

        // ── 1 · a toast over a page that is already on screen ─────────────────────────────
        const first = await worktree('live-under-toast-a');
        rec.check('a worktree workspace was created', Boolean(first.workspace_id), JSON.stringify(first));
        if (!first.workspace_id) return;
        await d.settleDom(page, `document.querySelector(${JSON.stringify(row(first.workspace_id))}) !== null`, { ceilingMs: 10_000 });

        const linesBefore = shell.lines.length;
        const toastUp = await deleteFromSidebar(String(first.workspace_name ?? 'live-under-toast-a'));
        rec.check('the "Removed worktree" toast is up', toastUp, String(await page.eval(stackText)));
        if (!toastUp) return;
        const drawnBy = await d.settleDom(page, `document.querySelector('[data-testid="toast-stack"]')?.dataset.drawnBy === 'shell'`, {
            ceilingMs: 3_000
        });
        rec.check('the page hands the stack to the shell layer (not painted in the page)', drawnBy);

        const overlap = JSON.parse(
            String(
                await page.eval(`(() => {
                    const hole = document.querySelector('${pageSelector(paneID)}')?.getBoundingClientRect();
                    const toast = document.querySelector('[data-testid="toast-stack"]')?.getBoundingClientRect();
                    if (!hole || !toast) return 'null';
                    return JSON.stringify({
                        overlaps: toast.x < hole.x + hole.width && hole.x < toast.x + toast.width &&
                            toast.y < hole.y + hole.height && hole.y < toast.y + toast.height,
                        toast: { w: toast.width, h: toast.height }
                    });
                })()`)
            )
        );
        rec.check('the toast sits over the web pane', overlap?.overlaps === true, JSON.stringify(overlap));

        // Give a park every chance to happen before asserting it did not.
        await sleep(600);
        const parked = placements(shell.lines.slice(linesBefore), paneID).filter((entry) => entry.owner === 'holder');
        rec.check('the page under the toast stays in the window (no park)', parked.length === 0, JSON.stringify(parked));
        const live = await pageState();
        rec.check(
            'the pane shows its live page: visible, not covered, no still frame',
            live?.visible === 'true' && live?.covered === 'false' && live?.poster === false,
            JSON.stringify(live)
        );

        let target = null;
        await d.settle(
            async () => {
                target = (await listTargets(sandbox.debugPort)).find((entry) => entry.url.endsWith('/overlay.html')) ?? null;
                return target !== null;
            },
            { ceilingMs: 5_000 }
        );
        rec.check('the corner layer has its own document', target !== null);
        if (target === null) return;
        layer = await connect(target.webSocketDebuggerUrl, { repoRoot });
        const layerStack = `document.querySelector('[data-testid="corner-layer-stack"]')`;
        const drawn = await d.settle(
            async () => String(await layer.eval(`${layerStack}?.textContent ?? ''`)).includes('Removed worktree'),
            { ceilingMs: 3_000 }
        );
        rec.check('the layer draws the toast', drawn, String(await layer.eval(`${layerStack}?.textContent ?? 'none'`)));
        const layerBox = JSON.parse(
            String(await layer.eval(`(() => { const r = ${layerStack}?.getBoundingClientRect(); return JSON.stringify(r ? { w: r.width, h: r.height } : null); })()`))
        );
        rec.check(
            'the layer draws it at the size the page measured',
            layerBox !== null && Math.abs(layerBox.w - overlap.toast.w) <= 1 && Math.abs(layerBox.h - overlap.toast.h) <= 1,
            JSON.stringify({ layer: layerBox, page: overlap.toast })
        );
        await rec.shot(layer, 'layer-drawing-the-toast');

        const card = await layer.box(`[data-testid^="toast-worktree-cleanup-"]`);
        rec.check('the layer card can be clicked', card !== null && card.width > 0, JSON.stringify(card));
        if (card !== null) {
            await layer.clickAt(card.cx, card.cy);
            const dismissed = await d.settleDom(page, `document.querySelector('[data-testid="toast-stack"]') === null`, { ceilingMs: 3_000 });
            rec.check('a click on the layer card dismisses the toast', dismissed);
            const cleared = await d.settle(async () => (await layer.eval(`${layerStack} === null`)) === true, { ceilingMs: 3_000 });
            rec.check('and the layer draws nothing afterwards', cleared);
        }
        rec.check(
            'the page was never parked through all of it',
            placements(shell.lines.slice(linesBefore), paneID).every((entry) => entry.owner === 'main'),
            JSON.stringify(placements(shell.lines.slice(linesBefore), paneID))
        );

        // ── 2 · a page that arrives on screen with the toast already up (#358) ─────────────
        const second = await worktree('live-under-toast-b');
        const plain = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'live-under-toast-other', '--json']));
        if (plain.workspace_id) cleanupWorkspaces.push(plain.workspace_id);
        rec.check('a second worktree workspace and a neighbour exist', Boolean(second.workspace_id && plain.workspace_id));
        if (!second.workspace_id || !plain.workspace_id) return;
        await d.settleDom(page, `document.querySelector(${JSON.stringify(row(second.workspace_id))}) !== null`, { ceilingMs: 10_000 });
        await page.click(row(second.workspace_id));
        const away = await d.settle(() => ownerOf(shell, paneID)?.owner === 'holder', { ceilingMs: 5_000, intervalMs: 50 });
        rec.check('switching to the worktree workspace parks the web pane, as any switch does', away, JSON.stringify(ownerOf(shell, paneID)));

        const secondUp = await deleteFromSidebar(String(second.workspace_name ?? 'live-under-toast-b'));
        rec.check('deleting the active worktree workspace raises the toast', secondUp);
        if (!secondUp) return;
        const linesArrive = shell.lines.length;
        await page.click(row(home));
        const arrived = await d.settleDom(page, `document.querySelector('${pageSelector(paneID)}') !== null`, { ceilingMs: 3_000 });
        const stillUp = (await page.eval(`document.querySelector('[data-testid="toast-stack"]') !== null`)) === true;
        rec.check('the web pane arrives on screen while the toast is still up', arrived && stillUp, JSON.stringify({ arrived, stillUp }));
        const back = await d.settle(() => ownerOf(shell, paneID)?.owner === 'main', { ceilingMs: 5_000, intervalMs: 50 });
        await sleep(400);
        const arrivedState = await pageState();
        rec.check(
            'it arrives live: placed in the window, no still frame, while the toast is up',
            back &&
                placements(shell.lines.slice(linesArrive), paneID).at(-1)?.owner === 'main' &&
                arrivedState?.visible === 'true' &&
                arrivedState?.poster === false,
            JSON.stringify({ placements: placements(shell.lines.slice(linesArrive), paneID), state: arrivedState })
        );
        for (const line of shell.lines.filter((entry) => entry.includes('corner layer'))) rec.note(line.trim());
    } finally {
        layer?.close();
        if (paneID !== null) await cli.run(['pane', 'close', '--target', paneID]);
        for (const id of cleanupWorkspaces) await cli.run(['workspace', 'delete', id, '--force']);
        server.close();
    }
}
