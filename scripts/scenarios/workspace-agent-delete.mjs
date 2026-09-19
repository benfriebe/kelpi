/** #241: an idle, resumable session must survive every unconfirmed workspace delete. */
export const covers = [
    'packages/client/src/App.tsx',
    'packages/client/src/chrome/Sidebar.tsx',
    'packages/client/src/features/workspaces.tsx',
    'packages/core/src/agent/session.ts',
    'packages/daemon/src/store/derived.ts',
    'packages/daemon/src/handlers/app/workspaces.ts',
    'packages/cli/src/commands/workspace.ts'
];

export default async function ({ page, cli, rec, d }) {
    const original = JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const originalActive = original.find(workspace => workspace.is_active)?.id;
    const name = `inactive-delete-${Date.now().toString(36)}`;
    let workspaceID;
    try {
        const created = JSON.parse(await cli.ok(['workspace', 'create', '--name', name, '--json']));
        workspaceID = created.workspace_id;
        const panes = JSON.parse(await cli.ok(['pane', 'list', '--workspace', workspaceID, '--json']));
        const paneID = panes[0].id;
        const bound = await cli.run(['event', 'session-start', '--agent', 'codex'], {
            env: { KELPI_PANE_ID: paneID }, stdin: JSON.stringify({ session_id: 'issue-241-inactive' })
        });
        rec.check('bound an idle resumable session', bound.code === 0, bound.stderr);
        rec.check('session is inactive on the wire', await d.settle(async () => {
            const current = JSON.parse(await cli.ok(['pane', 'list', '--workspace', workspaceID, '--json']));
            return current[0].status === 'idle' && current[0].agent_session_id === 'issue-241-inactive';
        }, { ceilingMs: 5_000 }));

        const refused = await cli.run(['workspace', 'delete', workspaceID, '--json']);
        const result = JSON.parse(refused.stdout)[0];
        rec.check('CLI refuses an inactive session with its exact breakdown', refused.code === 1 &&
            result.active_agents === 1 && result.running === 0 && result.waiting === 0 && result.inactive === 1 &&
            result.error === `workspace ${name} has 1 inactive agent; pass --force to delete anyway`, refused.stdout);

        await d.settleDom(page, `document.querySelector('[data-testid="pane-header-${paneID}"]')`, { ceilingMs: 5_000 });
        await d.openSidebarMenu(page, d.PAGE.workspaceRows, name);
        await d.clickMenuItem(page, 'Delete');
        const warning = 'This workspace has 1 inactive agent. Deleting it will close it.';
        rec.check('sidebar warns about the inactive session', await d.settleDom(page,
            `document.querySelector('[data-testid="confirm-active-agents"]')?.textContent === ${JSON.stringify(warning)}`,
            { ceilingMs: 5_000 }));
        await page.key('Escape');
        await d.settleDom(page, `document.querySelector('[data-testid="confirm-dialog"]') === null`);

        await d.clickPaneHeader(page, paneID);
        await page.key('KeyW', { key: 'w', modifiers: d.MOD.meta });
        rec.check('last-pane Command-W warns about the inactive session', await d.settleDom(page,
            `document.querySelector('[data-testid="agent-delete-gate"]')?.textContent.includes(${JSON.stringify(warning)})`,
            { ceilingMs: 5_000 }));
        await rec.shot(page, 'inactive-last-pane-warning');
        await page.key('Escape');
        rec.check('cancel preserves the workspace and session',
            JSON.parse(await cli.ok(['pane', 'list', '--workspace', workspaceID, '--json']))[0].agent_session_id === 'issue-241-inactive');

        const forced = await cli.run(['workspace', 'delete', workspaceID, '--force', '--json']);
        rec.check('force explicitly deletes the session workspace', forced.code === 0, forced.stderr || forced.stdout);
    } finally {
        await page.key('Escape');
        if (workspaceID) await cli.run(['workspace', 'delete', workspaceID, '--force']);
        if (originalActive) {
            const row = `[data-testid="workspace-row"][data-workspace-id="${originalActive}"]`;
            if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 5_000 })) await page.click(row);
        }
    }
}
