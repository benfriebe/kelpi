/**
 * #328: a link in a REMOTE workspace's terminal resolves on the daemon that owns the pane.
 *
 * A remote workspace (a second daemon's panes, drawn in this window) used to send its ⌘-click to
 * this window's daemon, which has no such pane and answered with an "Open path" toast reading
 * `pane not found: <id>`; its hover underline was switched off for the same reason. Now the pane
 * carries the remote runtime's commands and the app asks those.
 *
 * Two real daemons on this machine. The remote one prints a URL and a `.md` path into a shell
 * pane of its own workspace, opened in this window from the sidebar. Then, against that pane:
 *
 *   1. a plain hover underlines the URL (`data-terminal-link-underline`, the cells the remote
 *      daemon named);
 *   2. a ⌘-click opens exactly that URL (`harness.counters()`), with no failure toast;
 *   3. a plain click offers the link menu without "Open in Kelpi" (a web pane on the remote
 *      daemon would draw in that machine's shell, not here);
 *   4. a ⌘-click on the `.md` path opens a markdown pane on the REMOTE daemon, in its workspace,
 *      which this window shows, and none on the local one.
 */

import fs from 'node:fs';
import path from 'node:path';

import { makeCli, makeSandbox, PROTOCOL_VERSION, startDaemon, waitForHealthz } from '../ui-audit/lib/stack.mjs';

export const covers = [
    'packages/client/src/App.tsx',
    'packages/client/src/app/RemoteWorkspaceView.tsx',
    'packages/client/src/app/link-click.ts',
    'packages/client/src/phone/PhoneRemoteWorkspace.tsx',
    'packages/client/src/plugins/terminal-pane.ts',
    'packages/client/src/terminal/TerminalPane.tsx',
    'packages/client/src/terminal/link-hover.ts',
    'packages/client/src/terminal/pane-registry.ts'
];

const URL = 'https://example.com/remote/link';

export default async function ({ page, cli, sandbox, rec, d, sleep, repoRoot, harness }) {
    if (!sandbox) throw new Error('This scenario requires private booted instances');
    const previousConfig = fs.readFileSync(sandbox.configPath, 'utf8');
    const remote = await makeSandbox(repoRoot, { label: 'links-remote', clientDir: path.join(repoRoot, 'packages/client/dist') });
    const daemon = startDaemon(remote, { repoRoot });
    const remoteCLI = makeCli(remote, { repoRoot });
    const json = async (args) => JSON.parse(await remoteCLI.ok(args));
    try {
        await harness.focus();
        if (!(await page.eval(`!!document.querySelector('[data-testid="sidebar"]')`))) {
            await harness.menuClick({ path: ['View', 'Toggle Sidebar'] });
        }
        await waitForHealthz(remote.base);
        const workspace = (await json(['workspace', 'create', '--name', 'Remote links', '--json'])).workspace_id;
        const shell = (await json(['pane', 'list', '--workspace', workspace, '--json'])).find((pane) => pane.type === 'shell');
        rec.check('the remote workspace has a shell pane', shell !== undefined);
        if (shell === undefined) return;
        const paneID = shell.id;
        const localPanesBefore = JSON.parse(await cli.ok(['pane', 'list', '--json'])).map((pane) => pane.id);

        const token = fs.readFileSync(path.join(remote.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
        fs.writeFileSync(sandbox.configPath, `${previousConfig}\nremote-daemon = LinksRemote:${remote.base}/?token=${token}\n`);
        const row = `[data-testid="remote-daemon-LinksRemote"] [data-workspace-id="${workspace}"]`;
        rec.check('the remote daemon appears in the sidebar', await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 15_000 }));
        await page.click(row);
        const paneRoot = `[data-pane-id="${paneID}"][data-terminal-cell]`;
        rec.check('its shell pane is drawn in this window', await d.settleDom(page, `document.querySelector(${JSON.stringify(paneRoot)})`, { ceilingMs: 15_000 }));

        // The screen, printed by the remote pane's own shell.
        const markdown = path.join(remote.work, 'KELPI-328-NOTES.md');
        fs.writeFileSync(markdown, '# remote notes\n', 'utf8');
        const script = path.join(remote.work, 'kelpi-328-screen.sh');
        fs.writeFileSync(
            script,
            ['#!/bin/sh', "printf '\\033[2J\\033[H'", `printf 'see ${URL} now\\r\\n'`, `printf '${markdown}\\r\\n'`, 'sleep 120', ''].join('\n'),
            'utf8'
        );
        await remoteCLI.ok(['pane', 'send', '--target', paneID, `sh ${script}`]);
        rec.check(
            'the remote pane shows the link',
            await d.settle(async () => (await remoteCLI.ok(['pane', 'capture', '--target', paneID])).includes(URL), { ceilingMs: 8_000 })
        );
        await sleep(400);

        const metrics = await page.eval(
            `(() => {
                const root = document.querySelector(${JSON.stringify(paneRoot)});
                const host = root?.querySelector('[data-terminal-host]') ?? null;
                const canvas = host?.querySelector('canvas') ?? null;
                const cell = (root?.getAttribute('data-terminal-cell') ?? '').split('x');
                const rect = (canvas ?? host)?.getBoundingClientRect?.() ?? null;
                return { cellW: Number(cell[0] ?? 0), cellH: Number(cell[1] ?? 0), left: rect?.left ?? 0, top: rect?.top ?? 0 };
            })()`
        );
        const at = (r, c) => ({ x: metrics.left + (c + 0.5) * metrics.cellW, y: metrics.top + (r + 0.5) * metrics.cellH });
        const underline = () => page.eval(`document.querySelector(${JSON.stringify(paneRoot)})?.getAttribute('data-terminal-link-underline') ?? ''`);
        const toasts = () => page.eval(`document.querySelector('[data-testid="toast-stack"]')?.textContent ?? ''`);

        // 1. the hover
        await page.mouse('mouseMoved', metrics.left - 5, metrics.top - 5, { button: 'none', buttons: 0 });
        await sleep(100);
        const point = at(0, 10);
        await page.mouse('mouseMoved', point.x, point.y, { button: 'none', buttons: 0 });
        const want = `0:4+${String(URL.length)}`;
        await d.settle(async () => (await underline()) === want, { ceilingMs: 3_000, intervalMs: 50 });
        rec.check(`a plain hover underlines the URL the remote daemon names (${want})`, (await underline()) === want, `got "${String(await underline())}"`);
        await rec.shot(page, 'remote-url-hovered');

        // 2. the ⌘-click
        const before = await harness.counters();
        await page.clickAt(point.x, point.y, { modifiers: d.MOD.meta });
        await d.settle(async () => (await harness.counters()).externalOpens > before.externalOpens, { ceilingMs: 3_000, intervalMs: 100 });
        const after = await harness.counters();
        rec.check(
            `a ⌘-click opens exactly ${URL}`,
            after.externalOpens - before.externalOpens === 1 && after.lastExternalUrl === URL,
            `opened ${String(after.externalOpens - before.externalOpens)}, ${String(after.lastExternalUrl)}`
        );
        await sleep(300);
        rec.check('and raises no "pane not found" toast', !(await toasts()).includes('pane not found'), await toasts());

        // 3. the plain-click menu
        await page.clickAt(point.x, point.y);
        const menu = await d.settleDom(page, `[...document.querySelectorAll('[role="menuitem"]')].some((el) => el.textContent.includes('Open in Browser'))`, {
            ceilingMs: 3_000
        });
        const labels = await page.eval(`[...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim())`);
        rec.check('a plain click offers the link menu', menu, JSON.stringify(labels));
        rec.check('without "Open in Kelpi" for a remote pane', !labels.some((label) => label.includes('Open in Kelpi')), JSON.stringify(labels));
        await rec.shot(page, 'remote-link-menu');
        await page.key('Escape');
        await sleep(200);

        // 4. a .md path opens on the remote daemon
        const markdownPanes = async (list) => list.filter((pane) => pane.type === 'markdown' && String(pane.file_path ?? '').endsWith('KELPI-328-NOTES.md'));
        const mdPoint = at(1, 4);
        await page.clickAt(mdPoint.x, mdPoint.y, { modifiers: d.MOD.meta });
        let opened = [];
        await d.settle(
            async () => {
                opened = await markdownPanes(await json(['pane', 'list', '--workspace', workspace, '--json']));
                return opened.length === 1;
            },
            { ceilingMs: 5_000, intervalMs: 150 }
        );
        rec.check('a ⌘-click on the .md path opens a markdown pane on the remote daemon, in its workspace', opened.length === 1, JSON.stringify(opened));
        const localAfter = JSON.parse(await cli.ok(['pane', 'list', '--json']));
        rec.check(
            'and none on this window\'s daemon',
            localAfter.every((pane) => localPanesBefore.includes(pane.id)),
            JSON.stringify(localAfter.map((pane) => pane.id))
        );
        if (opened.length === 1) {
            rec.check(
                'which this window draws in the remote workspace',
                await d.settleDom(page, `document.querySelector('[data-pane-id="${opened[0].id}"]')`, { ceilingMs: 5_000 })
            );
            await rec.shot(page, 'remote-markdown-opened');
        }
        rec.check('no failure toast at all', !/Open (path|link)/.test(await toasts()), await toasts());
    } finally {
        fs.writeFileSync(sandbox.configPath, previousConfig);
        await d.settleDom(page, `!document.querySelector('[data-testid="remote-daemon-LinksRemote"]')`, { ceilingMs: 10_000 });
        await daemon.stop();
        remote.cleanup();
    }
}
