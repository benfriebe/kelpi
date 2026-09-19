import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandbox, startDaemon, waitForHealthz, makeCli, PROTOCOL_VERSION } from '../ui-audit/lib/stack.mjs';
import { phoneToLanding } from '../ui-audit/lib/workbench.mjs';

export const covers = ['packages/client/src/app/RemoteWorkspaceView.tsx', 'packages/client/src/phone/PhoneRemoteWorkspace.tsx', 'packages/client/src/plugins/', 'packages/daemon/src/plugins/',
    'packages/client/src/settings/RemoteTab.tsx', 'packages/client/src/settings/SettingsOverlay.tsx', 'packages/client/src/settings/sections.ts',
    'packages/client/src/settings/search-navigation.ts', 'packages/client/src/app/remote-daemons.ts',
    'packages/core/src/config/remote-daemons.ts'];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pluginID = 'example.agent-board', viewID = `${pluginID}.board`;

export default async function ({ page, cli, sandbox, rec, d }) {
    const originalURL = await page.eval('location.href');
    const remote = await makeSandbox(repoRoot, { label: 'plugin-remote', clientDir: path.join(repoRoot, 'packages/client/dist') });
    const daemonOptions = { repoRoot, packaged: process.env.KELPI_PLUGIN_PACKAGED === '1' };
    if (daemonOptions.packaged) rec.note('The remote daemon and plugin child runtime come from the packaged application.');
    let daemon = startDaemon(remote, daemonOptions);
    const remoteCLI = makeCli(remote, { repoRoot });
    const command = async args => {
        const result = await remoteCLI.run(args);
        if (result.code !== 0) throw new Error(`remote command failed: ${result.stderr || result.stdout}`);
        return JSON.parse(result.stdout);
    };
    const previousConfig = fs.readFileSync(sandbox.configPath, 'utf8');
    try {
        await waitForHealthz(remote.base);
        const localPanes = await cli.ok(['pane', 'list', '--json']);
        await command(['plugin', 'install', path.join(repoRoot, 'examples/plugins/agent-board'), '--trust']);
        const workspace = await command(['workspace', 'create', '--name', 'Remote plugin validation', '--json']);
        const pane = await command(['plugin', 'open', pluginID, viewID, '--workspace', workspace.workspace_id]);
        const token = fs.readFileSync(path.join(remote.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
        fs.writeFileSync(sandbox.configPath, `${previousConfig}\nremote-daemon = PluginRemote:${remote.base}/?token=${token}\n`);
        await page.watchFrames();
        const row = `[data-testid="remote-daemon-PluginRemote"] [data-workspace-id="${workspace.workspace_id}"]`;
        rec.check('a second real daemon appears in the local sidebar', await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 12_000 }));
        await page.click(row);
        const frame = `[data-testid="plugin-view-${pane.paneID}"] iframe`;
        const ready = () => d.settle(async () => { try { return await page.evalInFrame(frame, `(async () => (await kelpi.snapshot()).state.workspaces.some(workspace => workspace.id === ${JSON.stringify(workspace.workspace_id)}))()`); } catch { return false; } }, { ceilingMs: 15_000 });
        rec.check('remote plugin renders with a working API on its own daemon', await ready());
        // #193: default refusal, a real Settings/search grant, and live revocation. This
        // exercises the assembled primary provider around a plugin owned by the other daemon.
        const refusedNavigation = () => page.evalInFrame(frame, `(async () => {
            const errors = [];
            for (const [method, args] of [['ui.getNavigation', {}], ['ui.selectWorkspace', { hostID: 'local', workspaceID: 'anything' }]]) {
                try { await kelpi.call(method, args); errors.push('accepted'); }
                catch (error) { errors.push(String(error.message)); }
            }
            return errors.every(error => error.includes('unavailable for this daemon'));
        })()`);
        rec.check('remote plugin navigation reads and selection are refused by default', await refusedNavigation());
        const trustSelector = '[data-testid="remote-daemon-navigation-trust-PluginRemote"]';
        const setNavigationTrust = async trusted => {
            const beforeSearch = fs.readFileSync(sandbox.configPath, 'utf8');
            // Closing Settings returns focus to the plugin frame. Take it back into the host
            // before sending the window shortcut, including on an immediate clear/regrant.
            await page.click(row);
            await page.key('Comma', { modifiers: 4, key: ',' });
            if (!await d.settleDom(page, `document.querySelector('[data-testid="settings-search"]')`, { ceilingMs: 8_000 })) throw new Error('Settings did not open');
            await page.click('[data-testid="settings-search"]');
            await page.key('KeyA', { modifiers: 4, key: 'a' });
            await page.key('Backspace');
            await page.insertText('Trust plugins with navigation');
            const hit = '[data-testid="settings-search-result-remote-daemon-navigation-trust"]';
            if (!await d.settleDom(page, `document.querySelector(${JSON.stringify(hit)})`)) throw new Error('Navigation trust was not searchable');
            await page.click(hit);
            rec.check('Settings search reveals and focuses the real per-host navigation trust checkbox', await d.settleDom(page,
                `document.activeElement === document.querySelector(${JSON.stringify(trustSelector)})`));
            rec.check('revealing navigation trust through Settings search leaves configuration unchanged',
                fs.readFileSync(sandbox.configPath, 'utf8') === beforeSearch);
            if (await page.eval(`document.querySelector(${JSON.stringify(trustSelector)}).checked`) !== trusted) await page.click(trustSelector);
            rec.check(`navigation trust is ${trusted ? 'saved' : 'cleared'} in the primary host record`, await d.settle(async () => {
                const contents = fs.readFileSync(sandbox.configPath, 'utf8');
                return contents.includes('remote-daemon-navigation-trust = PluginRemote:') === trusted;
            }, { ceilingMs: 8_000 }));
            await page.click('[data-testid="settings-close"]');
            if (!await ready()) throw new Error('Remote plugin did not reattach after navigation trust changed');
        };
        await setNavigationTrust(true);
        const navigation = await page.evalInFrame(frame, `kelpi.ui.getNavigation()`);
        rec.check('trusted remote views can read this window navigation without credentials', navigation.hosts.some(host => host.kind === 'local') &&
            navigation.hosts.some(host => host.name === 'PluginRemote') && !JSON.stringify(navigation).includes(token));
        await page.evalInFrame(frame, `(() => {
            globalThis.__remoteNavigation = [];
            globalThis.__offRemoteNavigation = kelpi.ui.onNavigation(value => globalThis.__remoteNavigation.push(value));
            return true;
        })()`);
        rec.check('trusted remote views receive the navigation subscription', await d.settle(async () =>
            await page.evalInFrame(frame, `globalThis.__remoteNavigation.length > 0`), { ceilingMs: 8_000 }));
        const navigationWorkspace = await command(['workspace', 'create', '--name', 'Navigation subscription update', '--json']);
        rec.check('trusted remote navigation subscription follows live workspace changes', await d.settle(async () =>
            await page.evalInFrame(frame, `globalThis.__remoteNavigation.some(value => value.hosts.some(host => host.workspaces.some(workspace => workspace.id === ${JSON.stringify(navigationWorkspace.workspace_id)})))`), { ceilingMs: 8_000 }));
        const localHost = navigation.hosts.find(host => host.kind === 'local');
        const localWorkspace = localHost?.workspaces[0];
        if (!localWorkspace) throw new Error('No local workspace available for navigation regression');
        // Selection can unmount this calling frame before the RPC reply. Return first and
        // assert the visible destination in the host, not the lifetime of this CDP context.
        await page.evalInFrame(frame, `(() => {
            setTimeout(() => { void kelpi.ui.selectWorkspace(${JSON.stringify(localHost.id)}, ${JSON.stringify(localWorkspace.id)}); }, 0);
            return true;
        })()`);
        rec.check('trusted remote plugin can return the window to a local workspace', await d.settleDom(page,
            `!document.querySelector(${JSON.stringify(frame)}) && !!document.querySelector('[data-workspace-id="${localWorkspace.id}"][data-active="true"]')`, { ceilingMs: 8_000 }));
        await page.click(row);
        if (!await ready()) throw new Error('Remote plugin did not return');
        await setNavigationTrust(false);
        rec.check('clearing trust refuses navigation on the mounted remote host', await refusedNavigation());
        await setNavigationTrust(true);
        const identity = await page.evalInFrame(frame, `JSON.stringify(kelpi.context)`);
        const initialEpoch = await page.evalInFrame(frame, `(async () => (await kelpi.snapshot()).epoch)()`);
        await page.evalInFrame(frame, `kelpi.files.write(${JSON.stringify(path.join(remote.root, 'plugin-probe.txt'))}, 'remote filesystem')`);
        rec.check('file APIs execute on the remote daemon machine', fs.readFileSync(path.join(remote.root, 'plugin-probe.txt'), 'utf8') === 'remote filesystem' && !fs.existsSync(path.join(sandbox.root, 'plugin-probe.txt')));
        const executed = await page.evalInFrame(frame, `kelpi.process.exec(${JSON.stringify(process.execPath)}, ['-e', 'process.stdout.write(process.cwd())'], { cwd: ${JSON.stringify(remote.work)} })`);
        rec.check('process APIs execute in the remote working directory', fs.realpathSync(executed.stdout) === fs.realpathSync(remote.work));
        const cliResult = await page.evalInFrame(frame, `kelpi.process.exec(${JSON.stringify(process.execPath)}, [${JSON.stringify(path.join(repoRoot, 'packages/cli/dist/kelpi.js'))}, 'workspace', 'list', '--json'])`);
        rec.check('a CLI subprocess inherits its plugin daemon route', JSON.parse(cliResult.stdout).some(entry => entry.id === workspace.workspace_id || entry.workspace_id === workspace.workspace_id));
        await page.evalInFrame(frame, `kelpi.setState({ filter: 'remote remembered' })`);
        const before = (await command(['pane', 'list', '--workspace', workspace.workspace_id, '--json'])).length;
        await page.evalInFrame(frame, `document.getElementById('create').click()`);
        rec.check('remote custom UI commands create a remote terminal', await d.settle(async () => (await command(['pane', 'list', '--workspace', workspace.workspace_id, '--json'])).length === before + 1, { ceilingMs: 8_000 }));
        const localAfter = await cli.ok(['pane', 'list', '--json']);
        const ids = text => JSON.parse(text).map(pane => pane.pane_id ?? pane.id).sort().join(',');
        rec.check('remote commands leave the local pane set intact', ids(localPanes) === ids(localAfter));

        await daemon.stop(); daemon = startDaemon(remote, daemonOptions);
        await waitForHealthz(remote.base);
        rec.check('custom pane reconnects after a real daemon process restart', await ready());
        rec.check('restart preserves view state and daemon identity with a new event epoch', await page.evalInFrame(frame, `(async () => kelpi.state.filter === 'remote remembered' && kelpi.context.daemonID === ${JSON.stringify(JSON.parse(identity).daemonID)} && (await kelpi.snapshot()).epoch !== ${JSON.stringify(initialEpoch)})()`));

        // Reload the client URL without Electron's shellWindow identity: the ordinary browser path.
        const localToken = fs.readFileSync(path.join(sandbox.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
        await page.send('Page.navigate', { url: `${sandbox.base}/?token=${localToken}` });
        await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 12_000 });
        await page.click(row);
        rec.check('the same remote pane works through the ordinary browser client', await ready());
        rec.check('navigation trust survives a new client attachment', await page.evalInFrame(frame,
            `(async () => (await kelpi.ui.getNavigation()).hosts.some(host => host.kind === 'local'))()`));
        await setNavigationTrust(false);
        rec.check('cleared persisted trust refuses remote navigation again', await refusedNavigation());
        await rec.shot(page, 'remote-plugin-after-restart');

        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        const phoneRow = `[data-testid="phone-shell"] [data-workspace-id="${workspace.workspace_id}"]`;
        rec.check('the phone host picker includes the plugin workspace', await d.settleDom(page, `document.querySelector(${JSON.stringify(phoneRow)})`, { ceilingMs: 8_000 }));
        await page.click(phoneRow);
        await page.click('[data-testid="phone-title"]');
        await d.settleDom(page, `document.querySelector('[data-testid="phone-pane-show-${pane.paneID}"]')`);
        await page.click(`[data-testid="phone-pane-show-${pane.paneID}"]`);
        rec.check('phone single-pane mode renders the remote plugin and its saved state', await ready() && await page.evalInFrame(frame, `kelpi.state.filter === 'remote remembered'`));
    } finally {
        /*
         * Back to the landing page FIRST, before the config restore below and before the window
         * widens, while the phone shell is still mounted and the host it is on is still
         * configured: `phone/place.ts` remembers `{host, workspaceID}` and a remembered place
         * means the NEXT phone window opens there - on a remote host this block is about to stop -
         * instead of on the host picker this scenario's own first check reads (#205). This
         * scenario is the one that goes red when the place is left behind, so it is also the one
         * that must not leave it.
         */
        try {
            if (!await phoneToLanding(page, d, { note: message => rec.note(`cleanup: ${message}`) })) rec.note('cleanup: the phone shell never reached its landing page');
        } catch (error) {
            rec.note(`cleanup: the phone shell never reached its landing page — ${error instanceof Error ? error.message : String(error)}`);
        }
        fs.writeFileSync(sandbox.configPath, previousConfig);
        await page.send('Emulation.clearDeviceMetricsOverride');
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await page.send('Page.navigate', { url: originalURL });
        await d.settleDom(page, `document.querySelector('[data-testid="kelpi-app"]')?.getAttribute('data-connection') === 'connected'`, { ceilingMs: 10_000 });
        await daemon.stop(); remote.cleanup();
    }
}
