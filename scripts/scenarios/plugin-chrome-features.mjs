import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeSandbox, startDaemon, waitForHealthz, makeCli, PROTOCOL_VERSION } from '../ui-audit/lib/stack.mjs';
import { daemonIDFromSandbox, openPlacementSettings, phoneToLanding, restoreBundledSlots } from '../ui-audit/lib/workbench.mjs';

export const covers = ['examples/plugins/chrome-lab/', 'packages/plugin-sdk/', 'packages/client/src/features/',
    'packages/client/src/plugins/', 'packages/client/src/interaction/', 'packages/client/src/App.tsx', 'packages/client/src/chrome/'];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pluginID = 'example.chrome-lab', packagePath = path.join(repoRoot, 'examples/plugins/chrome-lab');
const toolbar = '[data-workbench-slot="topbar"] iframe', status = '[data-workbench-slot="statusbar"] iframe';

export default async function ({ page, cli, sandbox, rec, d }) {
    await page.watchFrames();
    const json = async args => JSON.parse(await cli.ok(args));
    const originalURL = await page.eval('location.href'), config = fs.readFileSync(sandbox.configPath, 'utf8');
    const initial = new Set((await json(['workspace', 'list', '--json'])).map(workspace => workspace.id));
    const inFrame = (selector, expression) => page.evalInFrame(selector, expression);
    const check = (selector, expression, ceilingMs = 12_000) => d.settle(async () => {
        try { return await inFrame(selector, expression); } catch { return false; }
    }, { ceilingMs });
    const ready = () => check(toolbar, `document.body.dataset.ready === 'true'`).then(async value => value && await check(status, `document.body.dataset.ready === 'true'`));
    const snapshot = () => inFrame(toolbar, 'kelpi.ui.getChrome()');
    const click = async (selector, target) => {
        if (!await check(selector, `document.querySelector(${JSON.stringify(target)}) && !document.querySelector(${JSON.stringify(target)}).disabled`)) throw new Error(`Missing or disabled ${target}`);
        const inner = await inFrame(selector, `(() => { const element = document.querySelector(${JSON.stringify(target)}); element.scrollIntoView({block:'center',inline:'center'}); const box = element.getBoundingClientRect(); return {x:box.x+box.width/2,y:box.y+box.height/2}; })()`);
        const outer = await page.box(selector); await page.clickAt(outer.x + inner.x, outer.y + inner.y);
    };
    const chooseViews = async () => {
        if (!await openPlacementSettings(page, d)) throw new Error('Settings did not open on its Plugins tab');
        for (const [slot, view] of [['topbar', 'toolbar'], ['statusbar', 'status']]) await page.eval(`(() => {
            const select = document.querySelector('select[aria-label="${slot}"]'); select.value = '${pluginID}.${view}'; select.dispatchEvent(new Event('change', {bubbles:true}));
        })()`);
        await page.click('[data-testid="settings-close"]'); if (!await ready()) throw new Error('Chrome Lab did not attach');
    };
    const selectWorkspace = async workspaceID => {
        await inFrame(toolbar, `void (async () => { const navigation = await kelpi.ui.getNavigation(); await kelpi.ui.selectWorkspace(navigation.hosts.find(host => host.kind === 'local').id, ${JSON.stringify(workspaceID)}); })().catch(error => { document.body.dataset.navigationError = error.message; }); true`);
        if (!await check(toolbar, `document.body.dataset.workspace === ${JSON.stringify(workspaceID)}`)) throw new Error('Workspace selection did not reach the toolbar');
    };
    const pick = async (title, text) => {
        await d.settleDom(page, `document.querySelector('input[aria-label=${JSON.stringify(title)}]')`);
        await page.insertText(text); await page.key('Enter');
    };
    let remote = null, remoteDaemon = null, observer = null;
    try {
        const directory = path.join(sandbox.root, 'chrome-repository'); fs.mkdirSync(directory); const repository = fs.realpathSync(directory);
        const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        git(['init', '--initial-branch=main']); fs.writeFileSync(path.join(repository, 'notes.md'), '# Chrome Lab\n');
        git(['add', '.']); git(['-c', 'user.name=Kelpi Scenario', '-c', 'user.email=scenario@localhost', 'commit', '-m', 'Private fixture']);
        const first = await json(['workspace', 'create', '--name', 'Chrome Alpha', '--path', repository, '--json']);
        const second = await json(['workspace', 'create', '--name', 'Chrome Beta', '--json']);
        const workspaceID = first.workspace_id, otherID = second.workspace_id;
        await json(['pane', 'create', '--workspace', workspaceID, '--json']);
        const paneID = (await json(['pane', 'list', '--workspace', workspaceID, '--json']))[0].id;
        const otherPane = (await json(['pane', 'list', '--workspace', otherID, '--json']))[0].id;
        await cli.ok(['plugin', 'install', packagePath, '--trust']); rec.note('Installed Chrome Lab; selecting replacement views'); await chooseViews(); rec.note('Both frames attached; selecting primary workspace'); await selectWorkspace(workspaceID);
        rec.check('both replacements attach as real isolated views without a backend', await ready() && await inFrame(toolbar, `(() => { try { parent.document.body; return false; } catch { return true; } })()`) && (await json(['plugin', 'list', '--json'])).find(plugin => plugin.manifest.id === pluginID).manifest.backend === undefined);
        rec.check('toolbar and status consume current workspace and focused pane state', await check(toolbar, `document.getElementById('workspace').textContent.includes('Chrome Alpha')`) && await check(status, `document.getElementById('cwd').textContent.includes('chrome-repository')`));
        rec.check('native window buttons retain a separate drag strip', await page.eval(`document.querySelector('[data-workbench-slot="topbar"] > [data-titlebar-drag]')?.getBoundingClientRect().width > 0`));
        rec.check('authored styles fit both hosts without horizontal overflow', await check(toolbar, `getComputedStyle(document.documentElement).fontSize === '12px' && document.documentElement.scrollWidth <= document.documentElement.clientWidth`) && await check(status, `document.documentElement.scrollWidth <= document.documentElement.clientWidth`));

        // Other scenarios retain this window's sidebar preferences. Establish the starting
        // visibility explicitly before testing one-toggle transitions.
        const initialChrome = await snapshot();
        if (!initialChrome.sidebars.left.visible) await click(toolbar, '#left');
        if (initialChrome.sidebars.right.visible) await click(toolbar, '#right');
        await check(toolbar, `document.getElementById('left').getAttribute('aria-pressed') === 'true' && document.getElementById('right').getAttribute('aria-pressed') === 'false'`);
        await click(toolbar, '#left'); rec.check('the replacement hides the left sidebar', await check(toolbar, `document.getElementById('left').getAttribute('aria-pressed') === 'false'`));
        await click(toolbar, '#left'); await click(toolbar, '#right'); rec.check('both physical sidebars remain controllable', await check(toolbar, `document.getElementById('left').getAttribute('aria-pressed') === 'true' && document.getElementById('right').getAttribute('aria-pressed') === 'true'`));
        await inFrame(toolbar, `kelpi.ui.selectView('sidebar.primary', 'kelpi.inspector')`);
        rec.check('sidebar swaps update replacement labels and physical toggle state', await check(toolbar, `document.getElementById('left').title.includes('Inspector') && document.getElementById('right').title.includes('Workspaces')`));
        await click(toolbar, '#left'); rec.check('the swapped left toggle closes Inspector', await check(toolbar, `(async () => (await kelpi.ui.getChrome()).sidebars.left.visible === false)()`));
        await inFrame(toolbar, `kelpi.ui.selectView('sidebar.primary', 'kelpi.workspaces')`);
        await inFrame(toolbar, `(() => { const select = document.getElementById('layout'); select.value = 'tiled'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
        rec.check('layout selection reaches daemon state through the chrome command', await check(toolbar, `(async () => (await kelpi.ui.getChrome()).workspace.layout === 'tiled')()`));
        await click(toolbar, '#sync'); rec.check('input synchronisation updates through the same live model', await check(toolbar, `document.getElementById('sync').getAttribute('aria-pressed') === 'true'`));
        await click(toolbar, '#sync');
        await selectWorkspace(otherID);
        const stale = await inFrame(toolbar, `kelpi.ui.executeChromeCommand('kelpi.layout.cycle', {workspaceID:${JSON.stringify(workspaceID)}}).then(() => false, error => error.message.includes('no longer selected'))`);
        rec.check('stale layout actions reject instead of changing the newly selected workspace', stale && (await snapshot()).workspace.id === otherID);
        await selectWorkspace(workspaceID);

        const longAgentLabel = `Chrome Beta agent ${'x'.repeat(240)}`;
        await cli.ok(['pane', 'name', longAgentLabel, '--target', otherPane]);
        await inFrame(toolbar, `kelpi.agents.setStatus(${JSON.stringify(otherPane)}, 'waitingForInput')`);
        rec.check('agent activity in another workspace updates the replacement footer', await check(status, `document.getElementById('waiting').textContent === '1 waiting'`));
        await click(status, '#waiting');
        rec.check('the agent picker accepts a long pane label and bounds its displayed row', await d.settleDom(page, `
            document.querySelector('input[aria-label="Waiting agents"]') &&
            [...document.querySelectorAll('[role="listbox"] [role="option"] > span:first-child')].some(row => row.textContent === ${JSON.stringify(longAgentLabel.slice(0, 200))})
        `));
        await pick('Waiting agents', 'Chrome Beta');
        rec.check('the shared agent picker selects and focuses its exact pane', await check(toolbar, `document.body.dataset.workspace === ${JSON.stringify(otherID)}`) && (await snapshot()).focusedPane.id === otherPane);
        await selectWorkspace(workspaceID); await inFrame(toolbar, `kelpi.agents.clearStatus(${JSON.stringify(otherPane)})`);
        await inFrame(toolbar, `(async () => { const rows = await kelpi.git.status(${JSON.stringify(workspaceID)}); if (!rows.some(row => row.worktreePath === ${JSON.stringify(repository)})) await kelpi.git.associate(${JSON.stringify(workspaceID)}, ${JSON.stringify(repository)}); })()`);
        fs.appendFileSync(path.join(repository, 'notes.md'), 'Changed\n');
        await inFrame(toolbar, `kelpi.git.status(${JSON.stringify(workspaceID)}, {refresh:true})`);
        await selectWorkspace(otherID); await selectWorkspace(workspaceID);
        rec.check('real Git changes reach the replacement status bar', await check(status, `document.getElementById('git').textContent.includes('1 files')`));
        await inFrame(toolbar, `kelpi.appSettings.setGeneral('show-system-stats', true)`);
        rec.check('real daemon samples populate enabled status metrics', await check(status, `(async () => { const state = await kelpi.ui.getChrome(); return state.systemStats?.length > 0 && document.getElementById('metrics').children.length > 0; })()`, 15_000));

        await cli.ok(['plugin', 'install', path.join(repoRoot, 'examples/plugins/ui-lab'), '--trust']);
        const toggle = async (field, value) => cli.ok(['plugin', 'run', 'example.ui-lab.toggle', '--args', JSON.stringify({ field, value })]);
        /*
         * How far one click moves the badge is UI Lab's OWN `step` setting, so it is read rather
         * than assumed to be the manifest default. `kelpi plugin remove` keeps a plugin's
         * persisted setting overrides, so a sandbox where `plugin-ui-services` has already run
         * hands this install a step of 3 and the badge goes 0 → 3 (#198). What this check is about
         * is that the click REACHED the declared command through the replacement status bar, which
         * is the same statement at either step.
         */
        const step = Number((await json(['plugin', 'settings', 'example.ui-lab'])).step ?? 1);
        rec.note(`UI Lab's counter step in this sandbox is ${String(step)}`);
        rec.check('other plugins retain their status contributions inside the replacement', await check(status, `document.querySelector('[data-id="example.ui-lab.counter"]')?.textContent.endsWith('0')`));
        await click(status, '[data-id="example.ui-lab.counter"]');
        rec.check('clicking a contributed status item executes its declared command', await check(status, `document.querySelector('[data-id="example.ui-lab.counter"]')?.textContent.endsWith('${String(step)}')`), `one click should add the configured step of ${String(step)}`);
        await toggle('enabled', false); rec.check('live enablement disables replacement contribution controls', await check(status, `document.querySelector('[data-id="example.ui-lab.counter"]')?.disabled === true`));
        await toggle('visible', false); rec.check('live visibility removes replacement contribution controls', await check(status, `!document.querySelector('[data-id="example.ui-lab.counter"]')`));
        await toggle('enabled', true); await toggle('visible', true);
        await click(toolbar, '#more'); await pick('Window commands', 'Plugins');
        rec.check('plugin management remains reachable through the replacement toolbar', await d.settleDom(page, `document.querySelector('[data-testid="settings-tab-button-plugins"]')?.getAttribute('aria-selected') === 'true'`));
        await page.click('[data-testid="settings-close"]');
        await click(toolbar, '#more'); await d.settleDom(page, `document.querySelector('input[aria-label="Window commands"]')`); await page.key('Escape');
        rec.check('cancelling the menu leaves the replacement operational', await ready());

        const token = fs.readFileSync(path.join(sandbox.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
        observer = new WebSocket(`${sandbox.base.replace(/^http/, 'ws')}/ws?token=${token}`);
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Size observer did not attach')), 10_000);
            observer.addEventListener('open', () => observer.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, token, client: { kind: 'browser', name: 'chrome-size-observer' } })));
            observer.addEventListener('message', ({ data }) => { const message = JSON.parse(String(data)); if (message.type === 'snapshot') { clearTimeout(timeout); resolve(); } });
            observer.addEventListener('error', reject, { once: true });
        });
        observer.send(JSON.stringify({ type: 'take-size-control' }));
        rec.check('a second client owning terminal geometry reveals size control', await check(toolbar, `!document.getElementById('size').hidden`));
        await click(toolbar, '#size'); rec.check('the replacement reclaims size control for its own window', await check(toolbar, `document.getElementById('size').hidden && document.body.dataset.connection === 'connected'`));
        observer.close(); observer = null;

        remote = await makeSandbox(repoRoot, { label: 'chrome-remote', clientDir: path.join(repoRoot, 'packages/client/dist') });
        remoteDaemon = startDaemon(remote, { repoRoot }); await waitForHealthz(remote.base);
        const remoteCLI = makeCli(remote, { repoRoot });
        await remoteCLI.ok(['plugin', 'install', path.join(repoRoot, 'examples/plugins/agent-board'), '--trust']);
        await remoteCLI.ok(['plugin', 'install', packagePath, '--trust']);
        const remoteWorkspace = JSON.parse(await remoteCLI.ok(['workspace', 'create', '--name', 'Remote Chrome', '--json']));
        const remotePane = JSON.parse(await remoteCLI.ok(['plugin', 'open', 'example.agent-board', 'example.agent-board.board', '--workspace', remoteWorkspace.workspace_id]));
        const remoteToken = fs.readFileSync(path.join(remote.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
        fs.writeFileSync(sandbox.configPath, `${config}\nremote-daemon = ChromeRemote:${remote.base}/?token=${remoteToken}\n`);
        await check(toolbar, `(async () => (await kelpi.ui.getNavigation()).hosts.some(host => host.name === 'ChromeRemote' && host.connection === 'connected'))()`, 15_000);
        await inFrame(toolbar, `(async () => { const navigation = await kelpi.ui.getNavigation(); const host = navigation.hosts.find(host => host.name === 'ChromeRemote'); await kelpi.ui.selectWorkspace(host.id, '${remoteWorkspace.workspace_id}'); })()`);
        rec.check('remote selection explicitly disables primary layout/input actions', await check(toolbar, `document.getElementById('sync').disabled && document.getElementById('layout').disabled && !document.getElementById('scope').hidden`));
        const remoteFrame = `[data-testid="plugin-view-${remotePane.paneID}"] iframe`;
        rec.check('a remote-owned pane cannot read another daemon window chrome', await check(remoteFrame, `kelpi.ui.getChrome().then(() => false, error => error.message.includes('unavailable'))`));
        await selectWorkspace(workspaceID);
        rec.check('returning to the primary workspace restores chrome actions', await check(toolbar, `!document.getElementById('sync').disabled`));
        await page.send('Page.navigate', { url: `${remote.base}/?token=${remoteToken}` });
        await d.settleDom(page, `document.querySelector('[data-testid="kelpi-app"]')?.getAttribute('data-connection') === 'connected'`);
        await chooseViews();
        rec.check('a direct browser attachment hosts independent remote toolbar/status replacements', await ready() && (await snapshot()).workspace.id === remoteWorkspace.workspace_id);
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        const phoneRow = `[data-testid="phone-shell"] [data-workspace-id="${remoteWorkspace.workspace_id}"]`;
        if (!await d.settleDom(page, `document.querySelector(${JSON.stringify(phoneRow)})`)) throw new Error('Phone workspace picker did not appear');
        await page.click(phoneRow); await page.click('[data-testid="phone-title"]');
        await d.settleDom(page, `document.querySelector('[data-testid="phone-pane-show-${remotePane.paneID}"]')`);
        await page.click(`[data-testid="phone-pane-show-${remotePane.paneID}"]`);
        rec.check('phone panes report desktop chrome unavailable instead of exposing hidden sidebar controls', await check(remoteFrame, `kelpi.ui.getChrome().then(() => false, error => error.message.includes('unavailable'))`));
        // Back to the landing page BEFORE the window widens again, while the shell is still
        // mounted: it is the one tap that forgets where this scenario took the phone.
        if (!await phoneToLanding(page, d)) rec.note('the phone shell did not return to its landing page; the next phone scenario may open where this one left it');
        await page.send('Emulation.clearDeviceMetricsOverride');
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await page.send('Page.navigate', { url: originalURL }); await ready();

        await cli.ok(['plugin', 'reload', pluginID]); rec.check('reload creates working bridges while preserving selections', await ready());
        await page.send('Page.reload'); rec.check('window reload restores both replacement views and live state', await ready());
        const before = (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).map(pane => pane.id).sort();
        await click(toolbar, '#more'); await pick('Window commands', 'Restart UI');
        rec.check('Restart UI restores the replacement chrome and preserves existing panes', await ready() && JSON.stringify((await json(['pane', 'list', '--workspace', workspaceID, '--json'])).map(pane => pane.id).sort()) === JSON.stringify(before));
        await cli.ok(['plugin', 'disable', pluginID]);
        rec.check('disable restores registered native toolbar and footer', await d.settleDom(page, `document.querySelector('[data-testid="top-bar"]') && document.querySelector('[data-testid="status-footer"]') && !document.querySelector(${JSON.stringify(toolbar)})`));
        await cli.ok(['plugin', 'enable', pluginID]); rec.check('reenabling restores the saved replacement choices', await ready());
        await rec.shot(page, 'chrome-lab-ready');
    } catch (error) { await rec.shot(page, 'failure-live'); throw error; }
    finally {
        /*
         * The sandbox, its daemon AND its window outlive this scenario, so every step below is an
         * undo and none of them is allowed to skip the rest: a throw in the middle of the run
         * leaves the phone on a remote workspace, both workbench slots naming views that are about
         * to be removed, and the window on a page this daemon does not serve (#205).
         */
        const safely = async (what, step) => {
            try { await step(); } catch (error) { rec.note(`cleanup: ${what} — ${error instanceof Error ? error.message : String(error)}`); }
        };
        observer?.close();
        // The app settings this scenario wrote (`show-system-stats`) live in the config file, so
        // putting the file back is what reverts them; the daemon watches it (§1.4).
        await safely('the config file goes back', () => fs.writeFileSync(sandbox.configPath, config));
        await safely('the phone returns to its landing page', async () => { if (!await phoneToLanding(page, d)) rec.note('cleanup: the phone shell never reached its landing page'); });
        await safely('device metrics are cleared', () => page.send('Emulation.clearDeviceMetricsOverride'));
        await safely('touch emulation is cleared', () => page.send('Emulation.setTouchEmulationEnabled', { enabled: false }));
        await safely('the window returns to the shell this runner launched', async () => {
            await page.send('Page.navigate', { url: originalURL });
            await d.settleDom(page, `document.querySelector('[data-testid="kelpi-app"]')?.getAttribute('data-connection') === 'connected'`, { ceilingMs: 20_000 });
        });
        // Both slots go back to the BUNDLED views rather than being left naming views that are
        // about to be removed, and after the navigation above so the selection is made in the
        // window that keeps it.
        await safely('both workbench placements go back to bundled', async () => {
            const restored = await restoreBundledSlots(page, d, { topbar: 'kelpi.topbar', statusbar: 'kelpi.statusbar' }, { daemonID: daemonIDFromSandbox(sandbox) });
            if (!restored.ok) rec.note(`cleanup: the workbench placements were not restored — ${String(restored.detail)}`);
            if (restored.others !== null) rec.note(`cleanup: a stopped daemon's store still holds ${String(restored.others)}`);
        });
        await safely('the Settings overlay is closed', async () => {
            if (await page.eval(`!!document.querySelector('[data-testid="settings-close"]')`)) await page.click('[data-testid="settings-close"]');
        });
        await cli.run(['plugin', 'remove', pluginID]); await cli.run(['plugin', 'remove', 'example.ui-lab']);
        for (const workspace of await json(['workspace', 'list', '--json'])) if (!initial.has(workspace.id)) await cli.run(['workspace', 'delete', workspace.id, '--force']);
        if (remoteDaemon) await remoteDaemon.stop();
        remote?.cleanup();
    }
}
