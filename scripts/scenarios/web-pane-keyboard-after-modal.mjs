/**
 * #351: closing a modal over a focused web page gives the page its keyboard back (§10.4).
 *
 * Every modal parks every web view in the off-screen holder while it is up (a native page would
 * otherwise slice the dialog), and every modal's close hands the keyboard back to the focused
 * pane, which for a web pane is the shell focusing the page view. The hand-back runs in the close
 * handler, before the modal unmounts, so it reached a view still in the holder; the placement that
 * brought the view back did nothing about focus, and typing reached nothing until the page was
 * clicked. On a9a87df this file failed four of the five closes below: the palette's Escape passed
 * only because its presenter hands back 200 ms later, after the view is already placed.
 *
 * **The signal is the page target's own `document.hasFocus()`.** The client window's reads true
 * while a web view holds the keyboard, and the shell's `focusing the page view` line is logged
 * whether or not the page ends up with it, which is how the audit's old check passed through the
 * bug. A lane's page focus is not exclusive either (the client and a page can both read true), so
 * every row first proves the page LOST the keyboard while the modal was up: a row cannot pass
 * because nothing ever moved.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MOD, connect, waitForPageTarget } from '../ui-audit/lib/cdp.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const covers = [
    'packages/shell/src/webhost/deferred-focus.ts',
    'packages/shell/src/webhost/tab.ts',
    'packages/shell/src/webhost/index.ts',
    'packages/shell/src/webhost/dispatch.ts',
    'packages/client/src/App.tsx',
    'packages/client/src/webpane/WebPane.tsx',
    'packages/client/src/chrome/modal-presence.ts'
];

/** CDP input has to reach the native page views (see `placement.mjs`). */
export const windowPlacement = 'offscreen';

const TAG = Math.random().toString(36).slice(2, 7).toUpperCase();

export default async function ({ page, harness, cli, sandbox, rec, d, sleep }) {
    const workspaces = JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const startingWorkspace = workspaces.find((workspace) => workspace.is_active === true)?.id ?? null;
    const created = [];
    const pages = [];
    const activeWorkspace = async () =>
        JSON.parse(await cli.ok(['workspace', 'list', '--json'])).find((w) => w.is_active === true)?.id ?? null;
    const visit = async (id) => {
        await page.eval(`document.querySelector('[data-workspace-id="${id}"]')?.click()`);
        await d.settle(async () => (await activeWorkspace()) === id);
    };
    const openPage = async (title, focus) => {
        await cli.ok(['web', 'open', ...(focus ? ['--focus'] : []), `data:text/html,<title>${title}</title><input autofocus>`]);
        const target = await waitForPageTarget(sandbox.debugPort, { match: (t) => t.title === title, timeoutMs: 15_000 });
        const web = await connect(target.webSocketDebuggerUrl, { repoRoot: REPO_ROOT });
        pages.push(web);
        return web;
    };
    try {
        // A workspace of its own (the ⌃Tab switcher's never-mind is the same hand-back, and
        // `recent-workspace-switcher.mjs` asserts it where that gesture is already driven).
        const home = JSON.parse(await cli.ok(['workspace', 'create', '--name', `Keys-${TAG}`, '--path', sandbox.root, '--json'])).workspace_id;
        created.push(home);
        await visit(home);
        const web = await openPage(`after-modal-${TAG}`, true);
        const hasKeyboard = (view) => view.eval('document.hasFocus()');
        const focusPage = async (view) => {
            await view.send('Page.bringToFront');
            return d.settle(() => hasKeyboard(view), { ceilingMs: 3000 });
        };

        const palette = () => page.eval(`document.querySelector('[data-testid="command-palette"]') !== null`);
        const settings = () => page.eval(`document.querySelector('${d.PAGE.settingsPanel}') !== null`);
        const help = () =>
            page.eval(`[...document.querySelectorAll('[role="dialog"]')].some((e) => e.getAttribute('aria-label') === 'Kelpi Help')`);

        /** One modal: the page has the keyboard, loses it under the modal, and has it again after. */
        const round = async (label, { open, isOpen, close, view = web, others = [] }) => {
            rec.check(`${label}: the page holds the keyboard first`, await focusPage(view));
            await open();
            if (!rec.check(`${label}: opened`, await d.settle(isOpen, { ceilingMs: 5000 }))) return;
            rec.check(
                `${label}: the page gave the keyboard up while it was open`,
                await d.settle(async () => (await hasKeyboard(view)) === false, { ceilingMs: 2000 })
            );
            await close();
            rec.check(`${label}: closed`, await d.settle(async () => !(await isOpen()), { ceilingMs: 3000 }));
            rec.check(`${label}: closing it gives the page its keyboard back (#351)`, await d.settle(() => hasKeyboard(view), { ceilingMs: 2000 }));
            for (const other of others) {
                rec.check(`${label}: and no other page took it`, (await hasKeyboard(other)) === false);
            }
        };

        const openPalette = () => web.key('KeyP', { modifiers: MOD.meta });
        await round('palette, Escape', { open: openPalette, isOpen: palette, close: () => page.key('Escape') });
        // ⌘W with nothing open closes the PANE, so the row above proved the palette is up.
        await round('palette, ⌘W', { open: openPalette, isOpen: palette, close: () => page.key('KeyW', { modifiers: MOD.meta }) });
        await round('Settings', { open: () => web.key('Comma', { modifiers: MOD.meta }), isOpen: settings, close: () => page.key('Escape') });
        await round('Help', {
            open: () => harness.menuClick({ path: ['Help', 'Kelpi Help'] }),
            isOpen: help,
            close: () => page.key('Escape')
        });
        // Two pages under one modal: both come back from the holder, and only the one that had
        // the keyboard takes it (a second placement must not steal it, nor be handed a claim).
        const second = await openPage(`after-modal-second-${TAG}`, false);
        await sleep(600);
        // Both pages are panes of this workspace, on screen: the row below is about two views
        // coming back from the holder, so it must not pass with the second one elsewhere.
        const webPanes = async () =>
            JSON.parse(await cli.ok(['pane', 'list', '--workspace', home, '--json'])).filter((pane) => pane.type === 'web').length;
        rec.check('the second page opened beside the first', (await activeWorkspace()) === home && (await webPanes()) === 2, `${String(await webPanes())} web panes`);
        rec.check(
            'both pages are drawn in the window',
            await d.settle(() => page.eval(`document.querySelectorAll('[data-testid^="web-pane-"]').length >= 2`), { ceilingMs: 3000 })
        );
        await round('two web panes, palette ⌘W', {
            open: openPalette,
            isOpen: palette,
            close: () => page.key('KeyW', { modifiers: MOD.meta }),
            others: [second]
        });
    } finally {
        for (const view of pages) view.close();
        if (startingWorkspace !== null) await visit(startingWorkspace).catch(() => {});
        for (const id of created) await cli.run(['workspace', 'delete', id, '--force']);
    }
}
