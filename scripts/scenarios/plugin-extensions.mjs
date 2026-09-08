import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const covers = ['packages/protocol/src/plugin', 'packages/daemon/src/plugins/', 'packages/daemon/src/boot/dispatch.ts', 'packages/daemon/src/ws/sync.ts', 'packages/client/src/plugins/', 'packages/client/src/App.tsx', 'packages/client/src/grid/', 'packages/plugin-sdk/', 'packages/cli/src/commands/plugin'];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lab = 'example.workbench-lab', dependency = 'example.agent-board';

export default async function ({ page, cli, sandbox, harness, rec, d }) {
    await page.watchFrames();
    const workspace = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'Extension validation', '--json']));
    const initialWorkspaces = new Set(JSON.parse(await cli.ok(['workspace', 'list', '--json'])).map(workspace => workspace.id ?? workspace.workspace_id));
    const fixture = path.join(sandbox.root, 'provider-fixture.txt');
    fs.writeFileSync(fixture, 'Private scenario file');
    const dashboard = `[data-workbench-slot="${lab}.metrics-slot"] iframe`;
    const notes = `[data-workbench-slot="${lab}.notes-slot"] iframe`;
    const painted = () => page.eval(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
    const pluginList = async () => JSON.parse(await cli.ok(['plugin', 'list']));
    const running = id => d.settle(async () => (await pluginList()).some(plugin => plugin.manifest.id === id && plugin.status === 'running'), { ceilingMs: 10_000 });
    const frameReady = frame => d.settle(async () => { try { return await page.evalInFrame(frame, `document.body.dataset.ready === 'true'`); } catch { return false; } }, { ceilingMs: 10_000 });
    const settings = async () => {
        await page.key('Comma', { modifiers: 4, key: ',' });
        await d.settleDom(page, `document.querySelector('[data-testid="settings-tab-button-plugins"]')`);
        await page.click('[data-testid="settings-tab-button-plugins"]');
        await d.settleDom(page, `document.querySelector('[data-testid="plugin-placements"]')`);
    };
    const select = (label, value) => page.eval(`(() => {
        const select = document.querySelector(${JSON.stringify(`select[aria-label="${label}"]`)});
        if (!select) throw new Error('missing select: ' + ${JSON.stringify(label)});
        select.value = ${JSON.stringify(value)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    const service = async () => JSON.parse(await cli.ok(['plugin', 'services'])).find(service => service.id === 'kelpi.files');
    try {
        const missing = await cli.run(['plugin', 'install', path.join(root, 'examples/plugins/workbench-lab'), '--trust']);
        rec.check('missing required dependency leaves an actionable installed-plugin error', missing.code !== 0 && (await pluginList()).some(plugin => plugin.manifest.id === lab && plugin.error?.includes(dependency)));
        await cli.ok(['plugin', 'install', path.join(root, 'examples/plugins/agent-board'), '--trust']);
        rec.check('installing the dependency automatically activates the waiting plugin', await running(lab));
        rec.check('the dependent backend can invoke a declared dependency command', Array.isArray(JSON.parse(await cli.ok(['plugin', 'run', `${lab}.dependency-history`]))));

        const denied = await cli.run(['workspace', 'create', '--name', 'Blocked by Workbench Lab', '--json']);
        rec.check('the CLI returns an operation veto before creating a workspace', denied.code !== 0 && `${denied.stderr}${denied.stdout}`.includes('Workbench Lab blocked'));
        await harness.menuClick({ path: ['File', 'New Workspace'] });
        await d.settleDom(page, `document.querySelector('[aria-label="New workspace name"]')`);
        await page.click('[aria-label="New workspace name"]');
        await page.insertText('Blocked by Workbench Lab');
        await page.click('[data-testid="new-workspace-submit"]');
        rec.check('native UI commands respect the same veto and display its reason', await d.settleDom(page, `document.body.innerText.includes('Workbench Lab blocked')`, { ceilingMs: 5000 }));
        if (await page.eval(`Boolean(document.querySelector('[data-testid="new-workspace-cancel"]'))`)) await page.click('[data-testid="new-workspace-cancel"]');

        await settings();
        await select('workspace', `${lab}.layout`);
        await page.click('[data-testid="settings-close"]');
        rec.check('a contributed layout hosts the live native pane grid and nested custom tabs', await frameReady(dashboard) && await page.eval(`Boolean(document.querySelector('[data-workbench-slot="${lab}.main"] [data-testid^="pane-header-"]')) && document.querySelectorAll('[data-workbench-container]').length === 2`));
        rec.check('a custom view discovers the native and contributed workbench slots', await page.evalInFrame(dashboard, `(async () => { const workbench = await kelpi.ui.getWorkbench(); return workbench.slots.some(slot => slot.id === '${lab}.notes-slot') && workbench.views.some(view => view.id === 'kelpi.workspaces'); })()`));
        await page.evalInFrame(dashboard, `kelpi.ui.selectView('${lab}.notes-slot', '')`);
        rec.check('a custom pane can change another named view slot through the UI API', await d.settleDom(page, `document.querySelector('[data-workbench-slot="${lab}.notes-slot"]')?.getAttribute('data-view-id') === null && !document.querySelector('[data-workbench-slot="${lab}.notes-slot"] iframe')`));
        await page.evalInFrame(dashboard, `kelpi.ui.selectView('${lab}.notes-slot', '${lab}.notes')`);
        await frameReady(notes);
        rec.check('invalid programmatic placement returns an error without changing the layout', await page.evalInFrame(dashboard, `(async () => { try { await kelpi.ui.selectView('${lab}.notes-slot', 'kelpi.shell'); return false; } catch { return (await kelpi.ui.getWorkbench()).slots.find(slot => slot.id === '${lab}.notes-slot').viewID === '${lab}.notes'; } })()`));
        await page.evalInFrame(dashboard, `document.getElementById('blocked').click(); true`);
        rec.check('typed plugin operations surface veto errors through the real frame bridge', await d.settle(async () => page.evalInFrame(dashboard, `document.getElementById('status').textContent.includes('Workbench Lab blocked')`)));
        rec.check('after hooks distinguish CLI, native UI, and plugin callers without duplicate dispatch', await d.settle(async () => {
            const history = JSON.parse(await cli.ok(['plugin', 'run', `${lab}.history`]));
            const blocked = history.filter(operation => operation.name === 'Blocked by Workbench Lab');
            return blocked.length === 3 && new Set(blocked.map(operation => operation.source)).size === 3 && blocked.every(operation => operation.result.code === 'PLUGIN_VETO');
        }));
        await page.evalInFrame(dashboard, `document.getElementById('create').click(); true`);
        rec.check('typed workspace operations update the native sidebar and return typed list data', await d.settleDom(page, `document.querySelector('[data-testid="sidebar"]')?.innerText.includes('Lab workspace')`) && await frameReady(dashboard) && await page.evalInFrame(dashboard, `(async () => (await kelpi.workspaces.list()).some(workspace => workspace.name === 'Lab workspace' && typeof workspace.id === 'string' && typeof workspace.paneCount === 'number'))()`));

        await page.evalInFrame(dashboard, `kelpi.ui.activateTab('${lab}.tools', '${lab}.notes-slot')`);
        await frameReady(notes);
        await page.evalInFrame(notes, `document.getElementById('notes').value = 'Retain this note'; document.getElementById('notes').dispatchEvent(new Event('input', { bubbles: true })); true`);
        await d.settle(async () => page.evalInFrame(notes, `document.getElementById('status').textContent === 'Saved'`));
        rec.check('inactive plugin tabs retain their documents and receive visible=false', await page.evalInFrame(dashboard, `kelpi.visible === false`) && await page.evalInFrame(notes, `kelpi.visible === true`));
        await page.send('Page.reload');
        rec.check('layout, active tab, and namespaced notes survive window reload', await frameReady(notes) && await page.evalInFrame(notes, `document.getElementById('notes').value === 'Retain this note' && kelpi.visible === true`));
        await page.click(`[data-workbench-container="${lab}.tools"] [role="tab"]:first-child`);
        await frameReady(dashboard);

        await settings();
        await d.settleDom(page, `document.querySelector('[data-testid="plugin-providers"] select')`);
        const providerLabel = await page.eval(`document.querySelector('[data-testid="plugin-providers"] select').getAttribute('aria-label')`);
        await select(providerLabel, `${lab}.files`);
        rec.check('Settings selects and persists an explicit service provider', await d.settle(async () => (await service()).activeProviderID === `${lab}.files`));
        await page.click('[data-testid="settings-close"]');
        await page.evalInFrame(dashboard, `document.getElementById('path').value = ${JSON.stringify(fixture)}; document.getElementById('read').click(); true`);
        rec.check('the plugin files API uses the selected provider through its backend', await d.settle(async () => page.evalInFrame(dashboard, `document.getElementById('file').textContent === ${JSON.stringify('[Workbench Lab]\nPrivate scenario file')}`)));
        rec.check('the CLI calls the same provider with explicit bundled delegation', JSON.parse(await cli.ok(['plugin', 'service-call', 'kelpi.files', 'read', '--args', JSON.stringify({ path: fixture })])) === '[Workbench Lab]\nPrivate scenario file');

        await settings();
        await page.click('[aria-label="Shortcut for Open Lab dashboard"]');
        // CDP on macOS needs the edit command as well as the key to select the existing text.
        await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'KeyA', key: 'a', windowsVirtualKeyCode: 65, modifiers: 4, commands: ['selectAll'] });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyA', key: 'a', windowsVirtualKeyCode: 65, modifiers: 4 });
        await page.insertText('super+alt+k');
        await page.click(`[data-testid="plugin-shortcuts-${lab}"] form:first-of-type button[type="submit"]`);
        const shortcutSaved = await d.settleDom(page, `document.querySelector('[aria-label="Shortcut for Open Lab dashboard"]')?.value === 'alt+super+k' && document.querySelector('[aria-label="Shortcut for Open Lab dashboard"]')?.getAttribute('aria-invalid') === 'false' && Object.keys(localStorage).filter(key => key.startsWith('kelpi.plugin-shortcuts.')).some(key => JSON.parse(localStorage.getItem(key))['${lab}.open'] === 'alt+super+k')`);
        rec.check('saving the edited shortcut persists its override without a validation error', shortcutSaved, await page.eval(`JSON.stringify((() => { const input = document.querySelector('[aria-label="Shortcut for Open Lab dashboard"]'); return { value: input.value, error: input.closest('form').querySelector('[role="alert"]')?.textContent ?? null, shortcuts: Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('kelpi.plugin-shortcuts.')).map(key => [key, localStorage.getItem(key)])) }; })())`));
        await page.click('[data-testid="settings-close"]');
        const before = JSON.parse(await cli.ok(['pane', 'list', '--json'])).length;
        await page.key('KeyK', { modifiers: 5, key: 'k', keyCode: 75 });
        rec.check('editing a plugin shortcut changes the live keybinding and opens its pane', await d.settle(async () => JSON.parse(await cli.ok(['pane', 'list', '--json'])).length === before + 1), await page.eval(`JSON.stringify({ shortcuts: Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('kelpi.plugin-shortcuts.')).map(key => [key, localStorage.getItem(key)])), focused: document.activeElement?.tagName, body: document.body.innerText.slice(-1200) })`));
        await painted();
        await rec.shot(page, 'nested-workbench-and-plugin-pane');

        await cli.ok(['plugin', 'disable', dependency]);
        rec.check('disabling a dependency stops its consumer and restores the native workspace', await d.settleDom(page, `!document.querySelector('[data-workbench-container]') && document.querySelector('[data-testid^="pane-header-"]')`) && (await pluginList()).some(plugin => plugin.manifest.id === lab && plugin.status === 'failed'));
        const fallback = await service();
        rec.check('an unavailable preferred provider falls back while retaining its selection', fallback.selectedProviderID === `${lab}.files` && fallback.activeProviderID === 'kelpi.files.bundled' && JSON.parse(await cli.ok(['plugin', 'service-call', 'kelpi.files', 'read', '--args', JSON.stringify({ path: fixture })])) === 'Private scenario file');
        await cli.ok(['plugin', 'enable', dependency]);
        rec.check('reenabling the dependency restores the chosen layout and provider automatically', await running(lab) && await frameReady(dashboard) && (await service()).activeProviderID === `${lab}.files`, JSON.stringify({ plugins: await pluginList(), service: await service(), body: await page.eval('document.body.innerText.slice(-1500)') }));
        await cli.ok(['plugin', 'reload', lab]);
        rec.check('backend reload restores nested view leases and preserves slot storage', await frameReady(dashboard) && await frameReady(notes) && await page.evalInFrame(notes, `document.getElementById('notes').value === 'Retain this note'`));
    } finally {
        if (await page.eval(`Boolean(document.querySelector('[data-testid="settings-close"]'))`)) await page.click('[data-testid="settings-close"]');
        await cli.run(['plugin', 'service-select', 'kelpi.files', 'default']);
        await cli.run(['plugin', 'remove', lab]);
        await cli.run(['plugin', 'remove', dependency]);
        for (const created of JSON.parse(await cli.ok(['workspace', 'list', '--json']))) {
            const id = created.id ?? created.workspace_id;
            if (!initialWorkspaces.has(id) || id === workspace.workspace_id) await cli.run(['workspace', 'delete', id, '--force']);
        }
    }
}
