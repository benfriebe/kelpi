import { executionRoots } from '../ui-audit/lib/execution-roots.mjs';
import path from 'node:path';
import { cleanupSteps } from '../ui-audit/lib/incident-diagnostics.mjs';
import { daemonIDFromSandbox } from '../ui-audit/lib/workbench.mjs';

export const covers = [
    'packages/client/src/App.tsx', 'packages/client/src/plugins/', 'packages/client/src/settings/',
    'packages/client/src/chrome/Sidebar.tsx', 'packages/client/src/chrome/Inspector.tsx',
    'packages/client/src/app/RemoteWorkspaceView.tsx', 'packages/client/src/grid/PaneHeader.tsx',
    'packages/daemon/src/plugins/', 'packages/daemon/src/ws/sync.ts', 'packages/daemon/src/db/',
    'packages/cli/src/commands/plugin.ts', 'packages/plugin-sdk/'
];
const packagePath = path.join(executionRoots().targetRoot, 'examples/plugins/agent-board');
const pluginID = 'example.agent-board', viewID = `${pluginID}.board`;

async function captureWorkbenchStore(page, daemonID) {
    if (daemonID === null) throw new Error('the fixture daemon identity is unavailable');
    const key = `kelpi.workbench.v1:${daemonID}`;
    return { key, value: await page.eval(`localStorage.getItem(${JSON.stringify(key)})`) };
}

async function restoreWorkbenchStore(page, snapshot) {
    await page.eval(`(() => {
        const key = ${JSON.stringify(snapshot.key)}, value = ${JSON.stringify(snapshot.value)};
        if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
        window.dispatchEvent(new CustomEvent('kelpi-workbench-selections', { detail: key }));
    })()`);
    await page.eval(`new Promise(resolve => requestAnimationFrame(() => resolve(true)))`);
    const restored = await page.eval(`localStorage.getItem(${JSON.stringify(snapshot.key)})`);
    if (restored !== snapshot.value) throw new Error(`workbench store ${snapshot.key} did not return to its incoming value`);
}

export default async function ({ page, harness, cli, sandbox, rec, d }) {
    await page.watchFrames();
    const failures = [];
    let offException = null, offLog = null, incomingWorkbenchStore;
    let workspaceID = null, pluginInstalled = false;
    const painted = () => page.eval(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
    const chooseSidebar = async (side, id) => {
        await painted();
        await page.click(`[data-testid="sidebar-view-picker-sidebar.${side}"]`);
        await d.settleDom(page, `document.querySelector('[data-menu-item="${id}"]')`);
        // Chromium's OOPIF hit-test regions update after the host menu reaches the DOM.
        await painted();
        await page.click(`[data-menu-item="${id}"]`);
    };
    const chooseSidebarSetting = (side, id) => page.eval(`(() => {
        const select = document.querySelector('select[aria-label="sidebar.${side}"]');
        select.value = ${JSON.stringify(id)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    const sidebarReady = side => d.settle(async () => {
        try { return (await page.evalInFrame(`[data-workbench-slot="sidebar.${side}"] iframe`, `document.querySelectorAll('.pane').length`)) > 0; }
        catch { return false; }
    }, { ceilingMs: 10_000 });
    const openRightSidebar = async () => {
        if (!await page.eval(`document.querySelector('[data-testid="toggle-inspector"]')?.getAttribute('aria-pressed') === 'true'`)) {
            await page.click('[data-testid="toggle-inspector"]');
        }
        const open = await d.settleDom(page, `(() => {
            const slot = document.querySelector('[data-testid="inspector-slot"]')?.getBoundingClientRect();
            const panel = document.querySelector('[data-testid="inspector-panel"]')?.getBoundingClientRect();
            return slot && panel && slot.width >= panel.width - 0.5 && panel.right <= innerWidth + 0.5;
        })()`, { ceilingMs: 3_000 });
        if (!open) throw new Error('the right sidebar did not finish opening');
    };
    try {
        offException = page.on('Runtime.exceptionThrown', details => failures.push(JSON.stringify(details)));
        offLog = page.on('Log.entryAdded', details => failures.push(JSON.stringify(details)));
        await page.send('Log.enable');
        incomingWorkbenchStore = await captureWorkbenchStore(page, daemonIDFromSandbox(sandbox));
        const created = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'Plugin validation', '--json']));
        workspaceID = created.workspace_id;
        const installed = await cli.run(['plugin', 'install', packagePath, '--trust']);
        rec.check('local plugin installs and activates through the shipped CLI', installed.code === 0, installed.stderr || installed.stdout);
        if (installed.code !== 0) return;
        pluginInstalled = true;
        const pane = JSON.parse(await cli.ok(['plugin', 'open', pluginID, viewID, '--workspace', workspaceID]));
        const frame = `[data-testid="plugin-view-${pane.paneID}"] iframe`;
        rec.check('plugin pane appears in the normal grid', await d.settleDom(page, `document.querySelector(${JSON.stringify(frame)})?.getAttribute('srcdoc')?.includes('Agent Board')`, { ceilingMs: 10_000 }));
        const ready = await d.settle(async () => {
            try { return (await page.evalInFrame(frame, `document.querySelectorAll('.pane').length`)) > 0; } catch { return false; }
        }, { ceilingMs: 12_000 });
        rec.check('the real sandboxed iframe renders daemon state using the SDK', ready);
        if (!ready) { rec.note(await page.eval(`document.body.innerText`)); rec.note(JSON.stringify(failures)); rec.note(await page.evalInFrame(frame, `JSON.stringify({html: document.body.innerHTML, api: typeof kelpi, ready: typeof kelpi === 'undefined' ? null : kelpi.context})`)); return; }
        const isolated = await page.evalInFrame(frame, `(() => { try { return parent.document.body.innerText; } catch { return 'isolated'; } })()`);
        rec.check('plugin cannot access the host DOM', isolated === 'isolated');
        rec.check('pane view receives daemon, client, workspace and pane context', await page.evalInFrame(frame, `kelpi.context.paneID === ${JSON.stringify(pane.paneID)} && kelpi.context.workspaceID === ${JSON.stringify(workspaceID)} && typeof kelpi.context.daemonID === 'string' && typeof kelpi.context.clientID === 'string'`));
        await page.evalInFrame(frame, `kelpi.setState({ filter: 'remember me' })`);
        const before = JSON.parse(await cli.ok(['pane', 'list', '--workspace', workspaceID, '--json']));
        await page.evalInFrame(frame, `document.getElementById('create').click()`);
        rec.check('custom UI creates a real terminal through shared daemon commands', await d.settle(async () => JSON.parse(await cli.ok(['pane', 'list', '--workspace', workspaceID, '--json'])).length > before.length, { ceilingMs: 6_000 }));
        const oldDocument = await page.eval(`document.querySelector(${JSON.stringify(frame)}).getAttribute('srcdoc')`);
        await cli.ok(['plugin', 'reload', pluginID]);
        rec.check('reload attaches a fresh view to the restarted backend', await d.settleDom(page, `document.querySelector(${JSON.stringify(frame)})?.getAttribute('srcdoc')?.includes('Agent Board') && document.querySelector(${JSON.stringify(frame)}).getAttribute('srcdoc') !== ${JSON.stringify(oldDocument)}`, { ceilingMs: 8_000 }));
        rec.check('reloading preserves pane state and restores a working API', await d.settle(async () => { try { return await page.evalInFrame(frame, `(async () => kelpi.state.filter === 'remember me' && document.getElementById('filter').value === 'remember me' && (await kelpi.snapshot()).state.workspaces.length > 0)()`); } catch { return false; } }, { ceilingMs: 8_000 }));
        await page.evalInFrame(frame, `document.getElementById('filter').focus()`);
        await page.key('Comma', { modifiers: 4, key: ',' });
        await d.settleDom(page, `document.querySelector('[data-testid="settings-tab-button-plugins"]')`);
        await page.click('[data-testid="settings-tab-button-plugins"]');
        rec.check('Kelpi shortcuts work while typing inside a plugin and open management', await d.settleDom(page, `document.querySelector('[data-testid="plugin-placements"]')`));
        await chooseSidebarSetting('primary', viewID);
        await page.click('[data-testid="settings-close"]');
        const sidebar = '[data-workbench-slot="sidebar.primary"] iframe';
        rec.check('Workbench settings replace Workspaces with the live plugin view', await sidebarReady('primary'));
        // Issue #201: §WS-075's sheet is a window modal, so both routes to it must still land
        // while the plugin occupies `sidebar.primary` and the native sidebar (the request's only
        // consumer until now) is not mounted at all. Escape puts the window back where the rest
        // of this file expects it.
        const newWorkspaceSheet = () => d.settleDom(page, `document.querySelector('[aria-label="New workspace name"]')`, { ceilingMs: 8_000 });
        const sheetGone = () => d.settleDom(page, `!document.querySelector('[aria-label="New workspace name"]')`, { ceilingMs: 8_000 });
        await harness.menuClick({ path: ['File', 'New Workspace'] });
        const fromMenu = await newWorkspaceSheet();
        await page.key('Escape');
        await sheetGone();
        await page.key('KeyN', { modifiers: 4, key: 'n', keyCode: 78 });
        const fromChord = await newWorkspaceSheet();
        await page.key('Escape');
        await sheetGone();
        rec.check('File ▸ New Workspace and ⌘N draw the new-workspace sheet while a plugin replaces Workspaces', fromMenu && fromChord);
        await painted();
        await page.click('[data-testid="sidebar-view-picker-sidebar.primary"]');
        await d.settleDom(page, `document.querySelector('[role="menu"]')`);
        await page.key('Escape');
        rec.check('Escape closes the view menu and returns focus to its picker', await page.eval(`!document.querySelector('[role="menu"]') && document.activeElement?.getAttribute('data-testid') === 'sidebar-view-picker-sidebar.primary'`));
        await openRightSidebar();
        await chooseSidebar('secondary', viewID);
        rec.check('the right sidebar picker swaps Inspector independently', await sidebarReady('secondary') && await sidebarReady('primary'));
        await chooseSidebar('primary', 'kelpi.workspaces');
        rec.check('the plugin header restores Workspaces without a filter picker while the right plugin stays active', await d.settleDom(page, `document.querySelector('[data-testid="sidebar-filter"]') && !document.querySelector('[data-testid="sidebar-view-picker-sidebar.primary"]') && document.querySelector('[data-workbench-slot="sidebar.secondary"] iframe')`));
        await page.key('Comma', { modifiers: 4, key: ',' });
        await d.settleDom(page, `document.querySelector('[data-testid="settings-tab-button-plugins"]')`);
        await page.click('[data-testid="settings-tab-button-plugins"]');
        await chooseSidebarSetting('primary', viewID);
        await page.click('[data-testid="settings-close"]');
        await page.send('Page.reload');
        await sidebarReady('primary');
        // The existing inspector starts closed on reload; its chosen view is remembered.
        await openRightSidebar();
        rec.check('both sidebar selections survive a window reload', await sidebarReady('primary') && await sidebarReady('secondary'));
        await chooseSidebar('secondary', 'kelpi.inspector');
        rec.check('the right plugin header restores the working Inspector', await d.settleDom(page, `document.querySelector('[data-testid="inspector-workspace"]') && document.querySelector(${JSON.stringify(sidebar)})`));
        await rec.shot(page, 'plugin-pane-and-sidebar');
        await page.evalInFrame(frame, `setTimeout(() => { throw new Error('intentional plugin view failure'); }, 0); true`);
        rec.check('an uncaught view error is isolated to a recoverable placeholder', await d.settleDom(page, `document.querySelector('[data-testid="plugin-view-${pane.paneID}"]')?.innerText.includes('intentional plugin view failure')`, { ceilingMs: 5_000 }));
        await page.click(`[data-testid="plugin-view-${pane.paneID}"] button`);
        rec.check('retry restores the view and API without losing saved state', await d.settle(async () => { try { return await page.evalInFrame(frame, `(async () => kelpi.state.filter === 'remember me' && (await kelpi.snapshot()).state.workspaces.length > 0)()`); } catch { return false; } }, { ceilingMs: 8_000 }));
        await cli.ok(['plugin', 'disable', pluginID]);
        rec.check('disabling restores bundled navigation and preserves the missing-plugin pane', await d.settleDom(page, `document.querySelector('[data-testid="sidebar-filter"]') && !document.querySelector('[data-testid="sidebar-view-picker-sidebar.primary"]') && document.querySelector('[data-testid="plugin-view-${pane.paneID}"]')?.innerText.includes('disabled')`, { ceilingMs: 8_000 }));
        await cli.ok(['plugin', 'enable', pluginID]);
        rec.check('reenabling recovers the existing pane', await d.settle(async () => { try { return await page.evalInFrame(frame, `kelpi.state.filter === 'remember me'`); } catch { return false; } }, { ceilingMs: 8_000 }));
        rec.check('reenabling restores the preferred sidebar with its picker still accessible', await sidebarReady('primary') && await page.eval(`document.querySelector('[data-testid="sidebar-view-picker-sidebar.primary"]')?.getAttribute('data-view-id') === ${JSON.stringify(viewID)}`));
        await chooseSidebar('primary', 'manage-plugins');
        rec.check('the sidebar picker opens plugin management directly', await d.settleDom(page, `document.querySelector('[data-testid="plugins-settings"]')`));
        await page.click('[data-testid="settings-close"]');
        const history = JSON.parse(await cli.ok(['plugin', 'run', `${pluginID}.history`]));
        rec.check('backend retained activity independently of view mounts', history.length > 0, JSON.stringify(history.slice(-3)));
    } finally {
        await cleanupSteps([
            ['runtime exception listener', () => offException?.()],
            ['log listener', () => offLog?.()],
            ['plugin removed', () => pluginInstalled ? cli.ok(['plugin', 'remove', pluginID]) : undefined],
            ['fixture workspace removed', () => workspaceID === null ? undefined : cli.ok(['workspace', 'delete', workspaceID, '--force'])],
            ['incoming workbench preferences', () => incomingWorkbenchStore === undefined ? undefined : restoreWorkbenchStore(page, incomingWorkbenchStore)]
        ], (label, detail) => rec.check(`cleanup: ${label}`, false, detail, 'cleanup'));
    }
}
