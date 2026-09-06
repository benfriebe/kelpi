/**
 * #53: the sidebar's delete confirmation binds Return and Escape, and Cancel is the default.
 *
 * shell-ui.md §12.2. The fix landed with a unit test; this is the check that would have
 * caught the original divergence, because it presses the real keys against the real dialog.
 */

/**
 * The source this presses, so `verify.mjs` re-runs it when that source moves (the scenario rule;
 * ui-audit/README.md ▸ The rule). `Sidebar.tsx` renders the rows, raises the confirmation and owns
 * the capture-phase Escape/Return handler that IS the assertion; `ContextMenu.tsx` is the row menu
 * the Delete verb is clicked in, and a change to how it dismisses would take the dialog with it.
 */
export const covers = ['packages/client/src/chrome/Sidebar.tsx', 'packages/client/src/chrome/ContextMenu.tsx'];

export default async function ({ page, cli, rec, d }) {
    const name = `doomed-${Date.now().toString(36)}`;
    const created = await cli.run(['workspace', 'create', '--name', name, '--json']);
    rec.check(`created workspace ${name} via the CLI`, created.code === 0, created.stderr || created.stdout);
    await d.settleDom(page, `Array.from(document.querySelectorAll('${d.PAGE.workspaceRows}')).some(el => (el.innerText ?? '').includes(${JSON.stringify(name)}))`, { ceilingMs: 5_000 });

    const listed = async () => (await cli.ok(['workspace', 'list'])).includes(name);
    const dialogUp = () => d.settleDom(page, `document.querySelector('${d.PAGE.confirmDialog}')`, { ceilingMs: 3_000 });
    const dialogGone = () => d.settle(async () => (await page.eval(`document.querySelector('${d.PAGE.confirmDialog}') === null`)) === true, { ceilingMs: 3_000 });

    const raise = async () => {
        await d.openSidebarMenu(page, d.PAGE.workspaceRows, name);
        const rows = await d.contextMenuRows(page);
        rec.note(`context menu rows: ${rows.join(' / ')}`);
        await d.clickMenuItem(page, 'Delete');
        return await dialogUp();
    };

    // 1. Escape cancels.
    rec.check('Delete raises the confirm dialog', await raise());
    await rec.shot(page, 'dialog-up');
    await page.key('Escape');
    rec.check('Escape closes the dialog', await dialogGone());
    rec.check('the workspace survives Escape', await listed());

    // 2. Return is Cancel, not Delete (§12.2: Cancel is the default button).
    rec.check('Delete raises the confirm dialog again', await raise());
    await page.key('Enter');
    rec.check('Return closes the dialog', await dialogGone());
    rec.check('the workspace survives Return: Cancel is the default', await listed());

    // 3. The Delete button still deletes, so the two above are not "the dialog is inert".
    rec.check('Delete raises the confirm dialog a third time', await raise());
    await d.clickDialogButton(page, 'Delete');
    rec.check('clicking Delete closes the dialog', await dialogGone());
    rec.check('clicking Delete removes the workspace', await d.settle(async () => !(await listed()), { ceilingMs: 5_000 }));
}
