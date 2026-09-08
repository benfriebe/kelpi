export const covers = [
    'packages/client/src/App.tsx', 'packages/client/src/plugins/',
    'packages/client/src/chrome/Sidebar.tsx', 'packages/client/src/chrome/Inspector.tsx',
    'packages/client/src/chrome/SidebarResizer.tsx', 'packages/client/src/chrome/TopBar.tsx'
];

export default async function ({ page, cli, harness, rec, d }) {
    const created = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'Sidebar swap', '--json']));
    const workspaceID = created.workspace_id;
    const painted = () => page.eval(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
    const choose = async (side, viewID) => {
        await painted();
        await page.click(`[data-testid="sidebar-view-picker-sidebar.${side}"]`);
        if (!await d.settleDom(page, `document.querySelector('[data-menu-item="${viewID}"]')`)) throw new Error('sidebar view menu did not open');
        await painted();
        await page.click(`[data-menu-item="${viewID}"]`);
    };
    const placed = swapped => d.settleDom(page, `(() => {
        const workspaces = document.querySelector('[data-testid="sidebar"]')?.getBoundingClientRect();
        const inspector = document.querySelector('[data-testid="inspector"]')?.getBoundingClientRect();
        if (!workspaces || !inspector) return false;
        const left = ${swapped} ? inspector : workspaces, right = ${swapped} ? workspaces : inspector;
        return left.left >= -0.5 && left.left < 1 && Math.abs(right.right - innerWidth) < 1 && left.right < right.left;
    })()`, { ceilingMs: 5_000 });
    await d.settleDom(page, `document.querySelector('[data-testid="sidebar-filter"]') && !document.querySelector('[data-testid="sidebar-view-picker-sidebar.primary"]')`);
    const initialWidth = await page.eval(`document.querySelector('[data-testid="sidebar"]')?.getBoundingClientRect().width`);
    try {
        if (typeof initialWidth === 'number' && initialWidth !== 220) {
            const handle = await page.box('[data-testid="sidebar-resizer"]');
            await page.drag(handle.cx, handle.cy, handle.cx + 220 - initialWidth, handle.cy);
        }
        await page.key('Comma', { modifiers: 4, key: ',' });
        await d.settleDom(page, `document.querySelector('[data-testid="settings-tab-button-plugins"]')`);
        await page.click('[data-testid="settings-tab-button-plugins"]');
        await page.eval(`(() => {
            const select = document.querySelector('select[aria-label="sidebar.primary"]');
            select.value = 'kelpi.inspector';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        })()`);
        await page.click('[data-testid="settings-close"]');
        rec.check('choosing Inspector on the left in Settings moves Workspaces to the right and opens both views', await placed(true));
        rec.check('each native sidebar has one host and the toolbar buttons describe their new positions', await page.eval(`document.querySelectorAll('[data-testid="sidebar"]').length === 1 && document.querySelectorAll('[data-testid="inspector"]').length === 1 && document.querySelector('[data-testid="toggle-sidebar"]').getAttribute('aria-label') === 'Toggle inspector' && document.querySelector('[data-testid="toggle-inspector"]').getAttribute('aria-label') === 'Toggle sidebar'`));
        await page.click('[data-testid="sidebar-filter"]');
        await page.insertText('Sidebar swap');
        rec.check('the right Workspaces sidebar filters workspace rows without a picker beside the filter', await d.settleDom(page, `!document.querySelector('[data-testid="sidebar-view-picker-sidebar.secondary"]') && document.querySelectorAll('[data-testid="workspace-row"]').length === 1 && document.querySelector('[data-testid="workspace-row"]')?.getAttribute('data-workspace-id') === ${JSON.stringify(workspaceID)}`), await page.eval(`JSON.stringify({ filter: document.querySelector('[data-testid="sidebar-filter"]')?.value, rows: [...document.querySelectorAll('[data-testid="workspace-row"]')].map(row => row.getAttribute('data-workspace-id')), active: document.activeElement?.tagName })`));
        await page.key('Escape');
        const handle = await page.box('[data-testid="sidebar-resizer"]');
        const before = await page.box('[data-testid="sidebar"]');
        rec.check('the Workspaces resize handle moves to its inner edge on the right', handle !== null && before !== null && Math.abs(handle.cx - before.x) < 4);
        await page.drag(handle.cx, handle.cy, handle.cx - 35, handle.cy);
        rec.check('dragging the right sidebar edge left makes Workspaces wider', await d.settleDom(page, `document.querySelector('[data-testid="sidebar"]').getBoundingClientRect().width >= ${before.width + 30}`));
        await page.click('[data-testid="inspector-close"]');
        rec.check('Inspector close hides the left view while Workspaces stays on the right', await d.settleDom(page, `!document.querySelector('[data-testid="inspector"]') && document.querySelector('[data-sidebar-side="right"] [data-testid="sidebar"]')`));
        await harness.menuClick({ path: ['View', 'Toggle Inspector'] });
        rec.check('the Inspector command reopens the view on the left', await placed(true));
        await page.click('[data-testid="toggle-inspector"]');
        await d.settleDom(page, `!document.querySelector('[data-testid="sidebar"]')`);
        await harness.menuClick({ path: ['File', 'New Workspace'] });
        rec.check('New Workspace reveals the sidebar on the right and opens its form', await d.settleDom(page, `document.querySelector('[data-sidebar-side="right"] [data-testid="sidebar"]') && document.querySelector('[data-testid="new-workspace-sheet"]')`));
        await page.click('[data-testid="new-workspace-cancel"]');
        await page.send('Page.reload');
        await d.settleDom(page, `document.querySelector('[data-sidebar-side="right"] [data-testid="sidebar"]')`);
        await harness.menuClick({ path: ['View', 'Toggle Inspector'] });
        rec.check('both native placements and the resized width survive a window reload', await placed(true) && await page.eval(`document.querySelector('[data-testid="sidebar"]').getBoundingClientRect().width >= ${before.width + 30}`));
        await rec.shot(page, 'inspector-left-workspaces-right');
        await choose('primary', 'kelpi.workspaces');
        rec.check('choosing Workspaces from the left Inspector header restores the original arrangement', await placed(false));
        await choose('secondary', 'kelpi.workspaces');
        rec.check('choosing Workspaces on the right also swaps both native views', await placed(true));
    } finally {
        // Hand a shared scenario run its ordinary arrangement and width back.
        try {
            if (await page.eval(`Boolean(document.querySelector('[data-testid="settings-close"]'))`)) await page.click('[data-testid="settings-close"]');
            if (await page.eval(`document.querySelector('[data-testid="sidebar-slot"]')?.getAttribute('data-sidebar-side') === 'right'`)) {
                if (!await page.eval(`Boolean(document.querySelector('[data-testid="sidebar-view-picker-sidebar.primary"]'))`)) await page.click('[data-testid="toggle-sidebar"]');
                await d.settleDom(page, `document.querySelector('[data-testid="sidebar-view-picker-sidebar.primary"]')`);
                await choose('primary', 'kelpi.workspaces');
                await placed(false);
            }
            if (!await page.eval(`Boolean(document.querySelector('[data-testid="sidebar"]'))`)) await page.click('[data-testid="toggle-sidebar"]');
            const handle = await page.box('[data-testid="sidebar-resizer"]');
            const width = await page.eval(`document.querySelector('[data-testid="sidebar"]')?.getBoundingClientRect().width`);
            if (handle && typeof initialWidth === 'number' && typeof width === 'number') await page.drag(handle.cx, handle.cy, handle.cx + initialWidth - width, handle.cy);
        } finally { await cli.run(['workspace', 'delete', workspaceID, '--force']); }
    }
}
