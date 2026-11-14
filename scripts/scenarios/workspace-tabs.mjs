/**
 * Workspace tabs in the title bar (workspace-feature.md §12, shell-ui.md §3.3).
 *
 * Every workspace has tabs, and every tab its own layout tree. This drives the real window the
 * way a person does: ⌥⌘T opens a tab after the one on screen, a split stays inside its tab, a
 * click and ⌥⌘N switch tabs and the grid follows, ⇧⌥⌘T takes the focused pane out into a tab
 * of its own, a double-click renames a tab in place and its × closes it with its panes. It
 * reads the answers back off the bar, the grid and `kelpi pane list` (which lists every tab's
 * panes with their tab), checks the drag region still carves every tab out whole, and restarts
 * the daemon to see the tabs come back from the database.
 */

/** The source this presses (the scenario rule; ui-audit/README.md ▸ The rule). */
export const covers = [
    'packages/client/src/chrome/TopBar.tsx',
    'packages/client/src/chrome/WorkspaceTabBar.tsx',
    'packages/client/src/chrome/workspace-tabs.ts',
    'packages/client/src/chrome/tab-drop.ts',
    'packages/client/src/features/workspace-tabs-actions.ts',
    'packages/client/src/chrome/keys.ts',
    'packages/client/src/App.tsx',
    'packages/client/src/styles.css',
    'packages/client/src/grid/PaneGrid.tsx',
    'packages/daemon/src/ws/workspace-tabs.ts',
    'packages/daemon/src/store/reducers/tabs.ts',
    'packages/daemon/src/store/tabs.ts',
    'packages/daemon/src/db/codec.ts',
    'packages/daemon/src/handlers/pane/list.ts'
];

export default async function ({ page, cli, rec, d, daemon }) {
    const rowOf = (workspaceID) => `[data-testid="workspace-row"][data-workspace-id="${workspaceID}"]`;
    const TABS = `[...document.querySelectorAll('[data-testid="workspace-tabs"] [role="tab"]')]`;
    const tabState = async () =>
        await page.eval(`${TABS}.map(tab => ({
            id: tab.getAttribute('data-workspace-tab-id'),
            active: tab.getAttribute('aria-selected') === 'true',
            title: tab.getAttribute('title'),
            count: tab.querySelector('[data-testid^="workspace-tab-count-"]')?.textContent?.trim() ?? null
        }))`);
    // A pane's wrapper (the one element per pane with `data-hidden`): its header carries the id too.
    const gridPanes = async () =>
        await page.eval(`document.querySelectorAll('[data-testid="pane-grid"] [data-pane-id][data-hidden]').length`);
    const activeIndex = (tabs) => tabs.findIndex((tab) => tab.active);
    const waitTabs = async (predicate, label) =>
        await d.settleDom(page, `(() => { const tabs = ${TABS}.map(tab => ({ active: tab.getAttribute('aria-selected') === 'true', title: tab.getAttribute('title') })); return (${predicate})(tabs); })()`, {
            ceilingMs: 8_000,
            label
        });
    const altMeta = d.MOD.alt | d.MOD.meta;

    const starting = JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const home = starting.find((workspace) => workspace.is_active === true)?.id ?? starting[0]?.id ?? null;
    const created = [];
    try {
        // ── 1 · a workspace starts with one tab, drawn in the title bar ──────────────────
        const made = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'Tabbed', '--focus', '--json']));
        if (typeof made.workspace_id === 'string') created.push(made.workspace_id);
        const workspaceID = made.workspace_id;
        await page.click(rowOf(workspaceID));
        const one = await waitTabs(`tabs => tabs.length === 1 && tabs[0].active`, 'one tab');
        rec.check('a new workspace has one tab, on screen, in the title bar', one, JSON.stringify(await tabState()));
        const drag = await page.eval(`(() => {
            const bar = document.querySelector('[data-testid="top-bar"]');
            const tab = ${TABS}[0];
            const lead = document.querySelector('[data-testid="top-bar-lead"]');
            return {
                bar: bar?.getAttribute('data-titlebar-drag') ?? null,
                tab: tab === undefined ? null : getComputedStyle(tab).getPropertyValue('-webkit-app-region'),
                separator: lead === null ? null : getComputedStyle(lead).borderRightWidth,
                identity: document.querySelector('[data-testid="top-bar-identity"]') !== null
            };
        })()`);
        rec.check(
            'the bar is still the drag handle, the tab opts out whole, a separator ends the leading controls, and no centred name',
            (drag.bar === 'true' || drag.bar === null) && (drag.tab === 'no-drag' || drag.bar === null) && drag.separator === '1px' && !drag.identity,
            JSON.stringify(drag)
        );

        // ── 2 · ⌥⌘T opens a tab after the one on screen, and shows it ────────────────────
        await page.key('KeyT', { modifiers: altMeta });
        const two = await waitTabs(`tabs => tabs.length === 2 && tabs[1].active`, 'two tabs');
        rec.check('⌥⌘T opens a second tab and shows it', two, JSON.stringify(await tabState()));
        const hiddenMounted = await page.eval(`document.querySelectorAll('[data-testid="pane-grid"] [data-pane-id][data-hidden="true"]').length`);
        rec.check(
            'the grid shows only the new tab\'s one pane, and keeps no hidden pane of the first tab mounted',
            (await gridPanes()) === 1 && hiddenMounted === 0,
            JSON.stringify({ panes: await gridPanes(), hiddenMounted })
        );

        // ── 3 · a split stays inside its tab ────────────────────────────────────────────
        await page.key('KeyD', { modifiers: d.MOD.meta });
        const split = await d.settleDom(page, `document.querySelectorAll('[data-testid="pane-grid"] [data-pane-id][data-hidden]').length === 2`, {
            ceilingMs: 8_000
        });
        const afterSplit = await tabState();
        rec.check(
            '⌘D splits inside the tab, and the tab counts its two panes',
            split && afterSplit.length === 2 && afterSplit[1]?.count === '2',
            JSON.stringify(afterSplit)
        );
        await rec.shot(page, 'two-tabs-one-split');

        // ── 4 · a click and ⌥⌘N switch tabs, and the grid follows ────────────────────────
        await page.click(`[data-workspace-tab-id="${afterSplit[0]?.id}"]`);
        const first = await waitTabs(`tabs => tabs[0].active`, 'first tab');
        rec.check('clicking the first tab shows it, with its one pane', first && (await gridPanes()) === 1, JSON.stringify({ tabs: await tabState(), panes: await gridPanes() }));
        await page.key('Digit2', { modifiers: altMeta });
        const second = await waitTabs(`tabs => tabs[1].active`, 'second tab');
        rec.check('⌥⌘2 shows the second tab and its split comes back', second && (await gridPanes()) === 2, JSON.stringify({ tabs: await tabState(), panes: await gridPanes() }));

        // ── 5 · ⇧⌥⌘T takes the focused pane out into a tab of its own ───────────────────
        await page.key('KeyT', { modifiers: altMeta | d.MOD.shift });
        const three = await waitTabs(`tabs => tabs.length === 3 && tabs[2].active`, 'three tabs');
        const afterMove = await tabState();
        rec.check(
            '⇧⌥⌘T moves the focused pane into a new tab after its own, and shows it',
            three && afterMove[1]?.count === null && (await gridPanes()) === 1,
            JSON.stringify({ tabs: afterMove, panes: await gridPanes() })
        );

        // ── 6 · `pane list` lists every tab's panes, with their tab ──────────────────────
        const listed = JSON.parse(await cli.ok(['pane', 'list', '--workspace', workspaceID, '--json']));
        const panes = Array.isArray(listed) ? listed : (listed.panes ?? []);
        const numbers = panes.map((pane) => pane.tab_number).sort();
        rec.check(
            'kelpi pane list names each pane\'s tab, the one on screen marked',
            panes.length === 3 &&
                JSON.stringify(numbers) === JSON.stringify([1, 2, 3]) &&
                panes.filter((pane) => pane.is_active_tab === true).length === 1,
            JSON.stringify(panes.map((pane) => ({ tab: pane.tab_number, active: pane.is_active_tab, focused: pane.is_focused })))
        );

        // ── 7 · a double-click renames a tab in place ────────────────────────────────────
        const firstID = afterMove[0]?.id;
        await page.eval(`document.querySelector('[data-workspace-tab-id="${firstID}"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
        const field = await d.settleDom(page, `document.activeElement?.getAttribute('data-testid') === 'workspace-tab-rename'`, { ceilingMs: 5_000 });
        await page.insertText('main');
        await page.key('Enter', { key: 'Enter' });
        const renamed = await waitTabs(`tabs => tabs[0].title === 'main'`, 'renamed');
        rec.check('double-click, a name and Enter rename the tab', field && renamed, JSON.stringify(await tabState()));

        // ── 8 · the tab on screen's × closes it with its pane ────────────────────────────
        const closing = afterMove[2]?.id;
        await page.click(`[data-testid="workspace-tab-close-${closing}"]`);
        const closed = await waitTabs(`tabs => tabs.length === 2`, 'closed');
        const left = JSON.parse(await cli.ok(['pane', 'list', '--workspace', workspaceID, '--json']));
        const leftPanes = Array.isArray(left) ? left : (left.panes ?? []);
        rec.check('the × closes the tab and the pane in it', closed && leftPanes.length === 2, JSON.stringify({ tabs: await tabState(), panes: leftPanes.length }));
        await rec.shot(page, 'renamed-and-closed');

        // ── 9 · a daemon restart brings the tabs back ────────────────────────────────────
        if (daemon === null) {
            rec.note('LIMIT: no sandbox daemon handle (--attach), so the restart check was skipped');
        } else {
            await page.eval(`(() => {
                const root = document.querySelector('[data-connection]');
                globalThis.__tabTrail = [];
                if (root === null) return;
                new MutationObserver(() => globalThis.__tabTrail.push(root.getAttribute('data-connection')))
                    .observe(root, { attributes: true, attributeFilter: ['data-connection'] });
            })()`);
            await daemon.restart();
            const reconnected = await d.settleDom(
                page,
                `globalThis.__tabTrail.some(state => state !== 'connected') && document.querySelector('[data-connection]')?.getAttribute('data-connection') === 'connected'`,
                { ceilingMs: 30_000 }
            );
            await page.click(rowOf(workspaceID));
            const back = await waitTabs(`tabs => tabs.length === 2 && tabs[0].title === 'main'`, 'restored');
            rec.check('after a daemon restart the workspace has its two tabs, the first still named', reconnected && back, JSON.stringify(await tabState()));
        }
        rec.check('the active tab is the one the bar marks', activeIndex(await tabState()) >= 0, JSON.stringify(await tabState()));
    } finally {
        await page.key('Escape', { key: 'Escape' });
        if (home !== null) await page.click(rowOf(home));
        for (const workspaceID of created) await cli.run(['workspace', 'delete', workspaceID, '--force']);
    }
}
