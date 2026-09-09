import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeSandbox, startDaemon, waitForHealthz, makeCli, PROTOCOL_VERSION } from '../ui-audit/lib/stack.mjs';

export const covers = ['examples/plugins/sidebar-lab/', 'packages/plugin-sdk/', 'packages/client/src/plugins/', 'packages/client/src/App.tsx', 'packages/client/src/app/RemoteWorkspaceView.tsx'];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packagePath = path.join(repoRoot, 'examples/plugins/sidebar-lab');
const pluginID = 'example.sidebar-lab', workspacesView = `${pluginID}.workspaces`, inspectorView = `${pluginID}.inspector`;

export default async function ({ page, cli, sandbox, rec, d }) {
    await page.watchFrames();
    const json = async args => JSON.parse(await cli.ok(args));
    const initialIDs = new Set((await json(['workspace', 'list', '--json'])).map(row => row.id));
    const originalURL = await page.eval('location.href');
    const previousConfig = fs.readFileSync(sandbox.configPath, 'utf8');
    let workspacesSide = 'primary', inspectorSide = 'secondary';
    const frame = side => `[data-workbench-slot="sidebar.${side}"] iframe`;
    const workspacesFrame = () => frame(workspacesSide), inspectorFrame = () => frame(inspectorSide);
    const inFrame = (selector, expression) => page.evalInFrame(selector, expression);
    const frameReady = selector => d.settle(async () => { try { return await inFrame(selector, `document.body.dataset.ready === 'true'`); } catch { return false; } }, { ceilingMs: 12_000 });
    const checkFrame = (selector, expression, ceilingMs = 8_000) => d.settle(async () => { try { return await inFrame(selector, expression); } catch { return false; } }, { ceilingMs });
    const styled = selector => checkFrame(selector, `(() => {
        const style = getComputedStyle(document.documentElement);
        const heading = getComputedStyle(document.querySelector('h1'));
        const icon = document.querySelector('.brand-mark svg').getBoundingClientRect();
        return style.fontFamily.includes('sans-serif') && heading.fontSize === '13px'
            && icon.width > 0 && icon.width <= 24 && style.backgroundColor !== 'rgba(0, 0, 0, 0)'
            && document.documentElement.scrollWidth <= document.documentElement.clientWidth;
    })()`);
    const click = async (selector, target) => {
        if (!await checkFrame(selector, `(() => { const target = document.querySelector(${JSON.stringify(target)}); return target && !target.disabled; })()`)) throw new Error(`missing or disabled ${target}`);
        const inner = await inFrame(selector, `(() => { const target = document.querySelector(${JSON.stringify(target)}); target.scrollIntoView({block:'center',inline:'nearest'}); const rect = target.getBoundingClientRect(); return {x:rect.x + rect.width / 2,y:rect.y + rect.height / 2,width:rect.width,height:rect.height}; })()`);
        const outer = await page.box(selector);
        if (!outer || !inner.width || !inner.height) throw new Error(`no visible target ${target}`);
        await page.clickAt(outer.x + inner.x, outer.y + inner.y);
    };
    const fill = async (selector, id, value) => {
        await click(selector, `#${id}`);
        await page.send('Input.dispatchKeyEvent', {type:'rawKeyDown',code:'KeyA',key:'a',windowsVirtualKeyCode:65,modifiers:4,commands:['selectAll']});
        await page.send('Input.dispatchKeyEvent', {type:'keyUp',code:'KeyA',key:'a',windowsVirtualKeyCode:65,modifiers:4});
        await page.insertText(value);
        if (!await checkFrame(selector, `document.getElementById(${JSON.stringify(id)}).value === ${JSON.stringify(value)}`)) throw new Error(`typing into ${id} did not reach the iframe: ${await inFrame(selector, `JSON.stringify({value:document.getElementById(${JSON.stringify(id)}).value,focus:document.activeElement?.id})`)}`);
    };
    const change = async (selector, id, value) => {
        if (typeof value === 'boolean') {
            if (await inFrame(selector, `document.getElementById(${JSON.stringify(id)}).checked`) !== value) await click(selector, `#${id}`);
        } else {
            // Native select popups have no portable CDP hit target. Exercise their public change event.
            await inFrame(selector, `(() => { const input = document.getElementById(${JSON.stringify(id)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('change', {bubbles:true})); })()`);
        }
    };
    const submit = (selector, id) => click(selector, `#${id} [data-submit]`);
    const openRight = async () => {
        await d.settleDom(page, `document.querySelector('[data-testid="toggle-inspector"]')`);
        if (!await page.eval(`document.querySelector('[data-testid="toggle-inspector"]')?.getAttribute('aria-pressed') === 'true'`)) await page.click('[data-testid="toggle-inspector"]');
        await d.settleDom(page, `document.querySelector('[data-workbench-slot="sidebar.secondary"]')?.getBoundingClientRect().width > 100`);
    };
    const chooseViews = async (left = workspacesView, right = inspectorView) => {
        await page.key('Comma', { modifiers: 4, key: ',' });
        await d.settleDom(page, `document.querySelector('[data-testid="settings-tab-button-plugins"]')`);
        await page.click('[data-testid="settings-tab-button-plugins"]');
        await d.settleDom(page, `document.querySelector('[data-testid="plugin-placements"]')`);
        for (const [side, id] of [['primary', left], ['secondary', right]]) await page.eval(`(() => { const select = document.querySelector('select[aria-label="sidebar.${side}"]'); select.value = ${JSON.stringify(id)}; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
        await page.click('[data-testid="settings-close"]');
        workspacesSide = left === workspacesView ? 'primary' : 'secondary'; inspectorSide = workspacesSide === 'primary' ? 'secondary' : 'primary';
        await openRight();
        if (!await frameReady(workspacesFrame()) || !await frameReady(inspectorFrame())) throw new Error('Sidebar Lab did not become ready');
    };
    const chooseWorkspace = async id => {
        await click(workspacesFrame(), `[data-workspace-id="${id}"] .workspace-button`);
        return checkFrame(inspectorFrame(), `document.body.dataset.workspaceId === ${JSON.stringify(id)}`);
    };
    const repository = path.join(sandbox.root, 'sidebar-repository');
    fs.mkdirSync(repository);
    const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '--initial-branch=main']);
    const notes = path.join(repository, 'NOTES.md'); fs.writeFileSync(notes, '# Sidebar Lab\n');
    git(['add', 'NOTES.md']); git(['-c', 'user.name=Kelpi Scenario', '-c', 'user.email=scenario@localhost', 'commit', '-m', 'Private fixture']);
    fs.appendFileSync(notes, '\nFirst change.\n');
    let remote = null, remoteDaemon = null;
    try {
        const alpha = await json(['workspace', 'create', '--name', 'Sidebar Alpha', '--path', sandbox.work, '--json']);
        const beta = await json(['workspace', 'create', '--name', 'Sidebar Beta', '--path', sandbox.work, '--json']);
        await cli.ok(['plugin', 'install', packagePath, '--trust']);
        await chooseViews();
        rec.check('the two replacement sidebars render through their sandboxed public SDKs', await checkFrame(workspacesFrame(), `document.querySelectorAll('.workspace-row').length >= 2`) && await inFrame(inspectorFrame(), `(() => { try { parent.document.body; return false; } catch { return true; } })()`));
        rec.check('both sandboxed views load styled, compact UI without horizontal overflow', await styled(workspacesFrame()) && await styled(inspectorFrame()));
        await fill(workspacesFrame(), 'filter', 'Alpha');
        rec.check('filtering hides unrelated workspaces without changing daemon state', await checkFrame(workspacesFrame(), `document.querySelectorAll('.workspace-row').length === 1 && !!document.querySelector('[data-workspace-id="${alpha.workspace_id}"]')`) && (await json(['workspace', 'list', '--json'])).some(row => row.id === beta.workspace_id));
        rec.check('selecting a filtered workspace updates the real Inspector context', await chooseWorkspace(alpha.workspace_id));
        await fill(inspectorFrame(), 'repository-path', path.join(sandbox.root, 'missing-repository'));
        await submit(inspectorFrame(), 'add-repository');
        rec.check('a failed repository action leaves a visible, recoverable error', await checkFrame(inspectorFrame(), `!document.getElementById('error').hidden && !!document.getElementById('error-message').textContent`));
        await fill(inspectorFrame(), 'repository-path', repository);
        await submit(inspectorFrame(), 'add-repository');
        const linked = await checkFrame(inspectorFrame(), `[...document.querySelectorAll('.repository')].some(row => row.innerText.includes('main') && row.querySelector('.git-state')?.dataset.kind === 'dirty')`);
        rec.check('Inspector associates a real repository and displays its branch and changes', linked, await inFrame(inspectorFrame(), 'document.body.innerText'));
        if (!linked) throw new Error('repository association did not render; see frame diagnostic');
        const beforeStats = await inFrame(inspectorFrame(), `document.querySelector('.added').textContent`);
        fs.appendFileSync(notes, 'Second change.\n');
        await click(inspectorFrame(), '#refresh');
        rec.check('explicit refresh loads fresh Git status', await checkFrame(inspectorFrame(), `document.querySelector('.added')?.textContent !== ${JSON.stringify(beforeStats)}`));
        await click(inspectorFrame(), '[data-open-diff]');
        let diff;
        rec.check('Inspector opens a native diff in its own workspace', await d.settle(async () => { diff = (await json(['pane', 'list', '--workspace', alpha.workspace_id, '--json'])).find(pane => pane.type === 'diff'); return !!diff; }));
        rec.check('the opened native diff displays the real repository content', !!diff && await checkFrame(`[data-testid="content-iframe-${diff.id}"]`, `document.body.innerText.includes('Second change')`));
        const beforePanes = await json(['pane', 'list', '--workspace', alpha.workspace_id, '--json']);
        await click(inspectorFrame(), '[data-repo-terminal]');
        let terminal;
        rec.check('repository terminal action creates a real shell in the repository folder', await d.settle(async () => { terminal = (await json(['pane', 'list', '--workspace', alpha.workspace_id, '--json'])).find(pane => !beforePanes.some(before => before.id === pane.id) && pane.type === 'shell'); return !!terminal && fs.realpathSync(terminal.working_directory) === fs.realpathSync(repository); }));
        await frameReady(inspectorFrame());
        await change(inspectorFrame(), 'terminal-target', terminal.id);
        await fill(inspectorFrame(), 'terminal-command', "printf 'SIDEBAR_LAB_LOCAL\\n'"); await submit(inspectorFrame(), 'terminal-form');
        rec.check('running a command targets the selected terminal', await d.settle(async () => (await cli.ok(['pane', 'capture', '--target', terminal.id, '--scrollback'])).includes('SIDEBAR_LAB_LOCAL')));
        await click(inspectorFrame(), '#capture-output');
        rec.check('reading terminal output uses the public capture API', await checkFrame(inspectorFrame(), `document.getElementById('terminal-output').textContent.includes('SIDEBAR_LAB_LOCAL')`));
        const beforeSplit = (await json(['pane', 'list', '--workspace', alpha.workspace_id, '--json'])).length;
        await click(inspectorFrame(), `[data-split-pane="${terminal.id}"]`);
        rec.check('the replacement Inspector splits an existing terminal', await d.settle(async () => (await json(['pane', 'list', '--workspace', alpha.workspace_id, '--json'])).length === beforeSplit + 1));
        await click(workspacesFrame(), `[data-rename-workspace="${alpha.workspace_id}"]`);
        await fill(workspacesFrame(), 'workspace-name', 'Sidebar Renamed'); await page.key('Enter');
        rec.check('Enter saves an inline workspace rename through the sandboxed form', await d.settle(async () => (await json(['workspace', 'list', '--json'])).some(row => row.id === alpha.workspace_id && row.name === 'Sidebar Renamed')));
        await click(workspacesFrame(), '#new-workspace'); await fill(workspacesFrame(), 'workspace-name', 'Sidebar Created'); await submit(workspacesFrame(), 'workspace-editor');
        let created;
        rec.check('workspace creation from the replacement sidebar creates a real workspace', await d.settle(async () => { created = (await json(['workspace', 'list', '--json'])).find(row => row.name === 'Sidebar Created'); return !!created; }));
        rec.check('creation selects the new workspace in the real window', await checkFrame(inspectorFrame(), `document.body.dataset.workspaceId === ${JSON.stringify(created.id)}`));

        await fill(workspacesFrame(), 'filter', 'Sidebar'); await change(workspacesFrame(), 'sort', 'name'); await change(workspacesFrame(), 'show-counts', false);
        await change(inspectorFrame(), 'show-paths', false);
        rec.check('sidebar preferences persist on the daemon', await checkFrame(workspacesFrame(), `(async () => { const value = await kelpi.storage.get('sidebar.workspaces.preferences'); return value.filter === 'Sidebar' && value.sort === 'name' && !value.showCounts; })()`) && await checkFrame(inspectorFrame(), `(async () => !(await kelpi.storage.get('sidebar.inspector.preferences')).showPaths)()`));
        await cli.ok(['plugin', 'reload', pluginID]);
        rec.check('plugin reload restores working sidebars and their preferences', await frameReady(workspacesFrame()) && await frameReady(inspectorFrame()) && await inFrame(workspacesFrame(), `document.getElementById('filter').value === 'Sidebar' && document.getElementById('sort').value === 'name' && !document.getElementById('show-counts').checked`) && await inFrame(inspectorFrame(), `!document.getElementById('show-paths').checked`));
        await chooseViews(inspectorView, workspacesView);
        rec.check('both custom sidebars work after exchanging left and right', await chooseWorkspace(alpha.workspace_id) && await checkFrame(inspectorFrame(), `document.querySelector('[data-open-diff]') && !document.querySelector('.repo-path')`));
        rec.check('swapped sidebar layouts retain their stylesheet and fit their columns', await styled(workspacesFrame()) && await styled(inspectorFrame()));
        await rec.shot(page, 'sidebar-lab-inspector-left-workspaces-right');
        await cli.ok(['plugin', 'disable', pluginID]);
        rec.check('disable restores bundled navigation and Inspector', await d.settleDom(page, `document.querySelector('[data-testid="sidebar-filter"]') && document.querySelector('[data-testid="inspector-workspace"]') && !document.querySelector('[data-workbench-slot^="sidebar."] iframe')`));
        await cli.ok(['plugin', 'enable', pluginID]);
        rec.check('reenable recovers the preferred swapped sidebars with saved filters', await frameReady(workspacesFrame()) && await frameReady(inspectorFrame()) && await inFrame(workspacesFrame(), `document.getElementById('filter').value === 'Sidebar'`));
        await page.send('Page.reload'); await openRight();
        rec.check('window reload retains custom side placement and daemon preferences', await frameReady(workspacesFrame()) && await frameReady(inspectorFrame()) && await inFrame(workspacesFrame(), `document.getElementById('sort').value === 'name'`));

        remote = await makeSandbox(repoRoot, { label: 'sidebar-remote', clientDir: path.join(repoRoot, 'packages/client/dist') });
        remoteDaemon = startDaemon(remote, { repoRoot }); await waitForHealthz(remote.base);
        const remoteCLI = makeCli(remote, { repoRoot });
        const remoteJSON = async args => { const result = await remoteCLI.run(args); if (result.code) throw new Error(result.stderr || result.stdout); return JSON.parse(result.stdout); };
        await remoteJSON(['plugin', 'install', packagePath, '--trust']);
        const remoteWorkspace = await remoteJSON(['workspace', 'create', '--name', 'Sidebar Remote', '--json']);
        const token = fs.readFileSync(path.join(remote.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
        fs.writeFileSync(sandbox.configPath, `${previousConfig}\nremote-daemon = SidebarRemote:${remote.base}/?token=${token}\n`);
        rec.check('replacement Workspaces discovers a connected remote host through public navigation', await checkFrame(workspacesFrame(), `document.querySelector('[data-host-name="SidebarRemote"] [data-workspace-id="${remoteWorkspace.workspace_id}"]')`, 15_000));
        await click(workspacesFrame(), `[data-host-name="SidebarRemote"] [data-workspace-id="${remoteWorkspace.workspace_id}"] .workspace-button`);
        rec.check('remote selection updates window navigation while local Inspector labels its own scope', await checkFrame(workspacesFrame(), `document.querySelector('[data-host-name="SidebarRemote"] [data-workspace-id="${remoteWorkspace.workspace_id}"]')?.dataset.active === 'true'`) && await checkFrame(inspectorFrame(), `document.body.dataset.navigationMismatch === 'true' && document.getElementById('navigation-note').textContent.includes('SidebarRemote')`));
        rec.check('remote navigation exposes no local mutation button on the remote row', await inFrame(workspacesFrame(), `!document.querySelector('[data-host-name="SidebarRemote"] [data-rename-workspace]')`));
        const localBefore = (await json(['workspace', 'list', '--json'])).map(row => row.id).sort();
        await page.send('Page.navigate', { url: `${remote.base}/?token=${token}` });
        await d.settleDom(page, `document.querySelector('[data-testid="kelpi-app"]')?.getAttribute('data-connection') === 'connected'`);
        await chooseViews();
        rec.check('a direct remote client loads independent sidebar preferences', await inFrame(workspacesFrame(), `document.getElementById('filter').value === '' && document.getElementById('show-counts').checked`));
        await click(workspacesFrame(), '#new-workspace'); await fill(workspacesFrame(), 'workspace-name', 'Remote Sidebar Created'); await submit(workspacesFrame(), 'workspace-editor');
        rec.check('the remote replacement creates a workspace only on its owning daemon', await d.settle(async () => (await remoteJSON(['workspace', 'list', '--json'])).some(row => row.name === 'Remote Sidebar Created')) && JSON.stringify((await json(['workspace', 'list', '--json'])).map(row => row.id).sort()) === JSON.stringify(localBefore));
        await frameReady(workspacesFrame()); await fill(workspacesFrame(), 'filter', 'Remote Sidebar');
        rec.check('remote preference writes stay on the remote daemon', await checkFrame(workspacesFrame(), `(async () => (await kelpi.storage.get('sidebar.workspaces.preferences')).filter === 'Remote Sidebar')()`));
        await page.send('Page.navigate', { url: originalURL }); workspacesSide = 'secondary'; inspectorSide = 'primary'; await openRight();
        rec.check('returning local restores its own filter and swapped layout', await frameReady(workspacesFrame()) && await inFrame(workspacesFrame(), `document.getElementById('filter').value === 'Sidebar' && !document.getElementById('show-counts').checked`));
    } catch (error) {
        await rec.shot(page, 'failure-live');
        throw error;
    } finally {
        fs.writeFileSync(sandbox.configPath, previousConfig);
        if (await page.eval('location.href') !== originalURL) await page.send('Page.navigate', { url: originalURL });
        await cli.run(['plugin', 'remove', pluginID]);
        for (const workspace of await json(['workspace', 'list', '--json'])) if (!initialIDs.has(workspace.id)) await cli.run(['workspace', 'delete', workspace.id, '--force']);
        if (remoteDaemon) await remoteDaemon.stop();
        remote?.cleanup();
    }
}
