/**
 * A workspace's hand-set Status, from the sidebar row menu (agent-lifecycle.md §5.10).
 *
 * The row menu's Status ▸ is the pane menu's (Idle / Running / Awaiting Input), set on a whole
 * workspace as a reminder to come back to it. This drives the real menu and reads back what a
 * person sees: the avatar's status dot on that row, lit by the workspace's own status with no
 * agent in it; Awaiting Input surviving while the workspace is NOT visited, cleared by a visit
 * (the pane's 600 ms focus dwell, keyed on the active workspace), and not cleared when it was set
 * on the workspace the user is already in (#108's lesson); and the status surviving a real daemon
 * restart, which a pane's never does (§6.1).
 */

/** The source this presses (the scenario rule; ui-audit/README.md ▸ The rule). */
export const covers = [
    'packages/client/src/chrome/Sidebar.tsx',
    'packages/client/src/App.tsx',
    'packages/daemon/src/ws/sync.ts',
    'packages/daemon/src/store/reducers/workspaces.ts',
    'packages/daemon/src/db/codec.ts'
];

export default async function ({ page, cli, rec, d, sleep, daemon }) {
    const rowOf = (workspaceID) => `[data-testid="workspace-row"][data-workspace-id="${workspaceID}"]`;
    const dotOf = (workspaceID) =>
        `document.querySelector('${rowOf(workspaceID)} [data-testid="status-dot"]')?.getAttribute('data-status') ?? null`;
    const dot = async (workspaceID) => await page.eval(dotOf(workspaceID));
    /** Right-click the row, open Status ▸ and pick one; returns the submenu as it was offered. */
    const pick = async (name, id) => {
        await d.openSidebarMenu(page, d.PAGE.workspaceRows, name);
        const rows = await d.openSubmenu(page, 'Status');
        await d.clickSubmenuItem(page, id);
        return rows;
    };
    const visit = async (workspaceID) => {
        await page.click(rowOf(workspaceID));
        await d.settleDom(page, `document.querySelector('${rowOf(workspaceID)}')?.getAttribute('aria-selected') === 'true'`, {
            ceilingMs: 3_000
        });
    };

    const starting = JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const home = starting.find((workspace) => workspace.is_active === true)?.id ?? starting[0]?.id ?? null;
    const created = [];
    try {
        // ── 1 · a fresh workspace in the background, nothing running in it ───────────────
        const made = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'Come Back', '--json']));
        if (typeof made.workspace_id === 'string') created.push(made.workspace_id);
        const flaggedID = made.workspace_id;
        if (home !== null) await visit(home);
        const rowUp = await d.settleDom(page, `document.querySelector('${rowOf(flaggedID)}') !== null`, { ceilingMs: 5_000 });
        rec.check('the new workspace has a sidebar row with no status dot', rowUp && (await dot(flaggedID)) === null, String(await dot(flaggedID)));

        // ── 2 · Status ▸ Awaiting Input from the row menu lights the avatar dot ──────────
        const offered = await pick('Come Back', 'status:waitingForInput');
        rec.check(
            'Status ▸ offers the pane menu\'s three statuses, Idle ticked',
            JSON.stringify(offered.map((row) => row.label)) === JSON.stringify(['Idle', 'Running', 'Awaiting Input']) &&
                offered.find((row) => row.id === 'status:idle')?.checked === 'true',
            JSON.stringify(offered)
        );
        const lit = await d.settleDom(page, `${dotOf(flaggedID)} === 'waiting'`, { ceilingMs: 5_000 });
        rec.check('Awaiting Input lights the row\'s avatar dot in the waiting colour', lit, String(await dot(flaggedID)));
        await rec.shot(page, 'row-awaiting-input');

        // ── 3 · it stays while the workspace is not visited ──────────────────────────────
        await sleep(1_500);
        rec.check('unvisited, the dot is still waiting after 1.5 s', (await dot(flaggedID)) === 'waiting', String(await dot(flaggedID)));

        // ── 4 · a visit acknowledges it, the way focus acknowledges a pane ───────────────
        await visit(flaggedID);
        const cleared = await d.settleDom(page, `${dotOf(flaggedID)} === null`, { ceilingMs: 5_000 });
        rec.check('visiting the workspace clears Awaiting Input and the dot goes', cleared, String(await dot(flaggedID)));

        // ── 5 · set where the user sits, it stays until they leave and come back ─────────
        await pick('Come Back', 'status:waitingForInput');
        const relit = await d.settleDom(page, `${dotOf(flaggedID)} === 'waiting'`, { ceilingMs: 5_000 });
        await sleep(1_500);
        rec.check(
            'Awaiting Input set on the active workspace is not undone by the visit timer',
            relit && (await dot(flaggedID)) === 'waiting',
            String(await dot(flaggedID))
        );
        await rec.shot(page, 'active-row-awaiting-input');

        // Running is never acknowledged by a visit.
        await pick('Come Back', 'status:running');
        const running = await d.settleDom(page, `${dotOf(flaggedID)} === 'running'`, { ceilingMs: 5_000 });
        if (home !== null) await visit(home);
        await visit(flaggedID);
        await sleep(1_500);
        rec.check('Running survives a visit', running && (await dot(flaggedID)) === 'running', String(await dot(flaggedID)));

        // ── 6 · a daemon restart keeps it ────────────────────────────────────────────────
        await pick('Come Back', 'status:waitingForInput');
        if (home !== null) await visit(home);
        await d.settleDom(page, `${dotOf(flaggedID)} === 'waiting'`, { ceilingMs: 5_000 });
        if (daemon === null) {
            rec.note('LIMIT: no sandbox daemon handle (--attach), so the restart check was skipped');
        } else {
            // A connection-state trail, so "connected" afterwards means RE-connected.
            await page.eval(`(() => {
                const root = document.querySelector('[data-connection]');
                globalThis.__statusTrail = [];
                if (root === null) return;
                new MutationObserver(() => globalThis.__statusTrail.push(root.getAttribute('data-connection')))
                    .observe(root, { attributes: true, attributeFilter: ['data-connection'] });
            })()`);
            await daemon.restart();
            const reconnected = await d.settleDom(
                page,
                `globalThis.__statusTrail.some(state => state !== 'connected') && document.querySelector('[data-connection]')?.getAttribute('data-connection') === 'connected'`,
                { ceilingMs: 30_000 }
            );
            const kept = await d.settleDom(page, `${dotOf(flaggedID)} === 'waiting'`, { ceilingMs: 10_000 });
            rec.check(
                'Awaiting Input survives a daemon restart',
                reconnected && kept,
                JSON.stringify({ reconnected, dot: await dot(flaggedID) })
            );
            await rec.shot(page, 'after-restart');
        }

        // ── 7 · Idle from the menu puts it back ──────────────────────────────────────────
        const asOffered = await pick('Come Back', 'status:idle');
        const off = await d.settleDom(page, `${dotOf(flaggedID)} === null`, { ceilingMs: 5_000 });
        rec.check(
            'the submenu ticked Awaiting Input, and Idle clears the dot',
            asOffered.find((row) => row.id === 'status:waitingForInput')?.checked === 'true' && off,
            JSON.stringify({ asOffered, dot: await dot(flaggedID) })
        );
    } finally {
        await page.key('Escape', { key: 'Escape' });
        if (home !== null) await page.click(rowOf(home));
        for (const workspaceID of created) await cli.run(['workspace', 'delete', workspaceID, '--force']);
    }
}
